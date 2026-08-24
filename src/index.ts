import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { createCaseSchema, isUuid } from "./schemas.js";
import { mapError } from "./errors.js";
import { userMessage } from "./error-messages.js";
import { createCase, dailySpendUsd, ensureSession, getCaseProjection, listCases, retryFailed, softDeleteCase } from "./repository.js";
import { startWorker, stopWorker } from "./worker.js";
import { isTerminal } from "./case-status.js";
import { selectablePanels, verifyPromptLock } from "./prompts-registry.js";

const app=Fastify({logger:true,bodyLimit:8192,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
await app.register(cookie);
app.addHook("onSend",async(_req,reply,payload)=>{reply.header("X-Content-Type-Options","nosniff").header("Referrer-Policy","no-referrer").header("X-Frame-Options","DENY").header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");return payload});
async function session(req:any,reply:any){let token=req.cookies.tribunal_session;if(!token){token=randomBytes(32).toString("base64url");reply.setCookie("tribunal_session",token,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production",path:"/",maxAge:60*60*24*365})}return ensureSession(token)}
const envelope=(req:any,code:string,message:string,details?:unknown)=>({error:{code,message,...(details?{details}:{}),request_id:req.id}});
const rejectId=(req:any,reply:any)=>{reply.code(400);return envelope(req,"invalid_case_id",userMessage("invalid_case_id"))};

app.get("/api/v1/health",async()=>({ok:true}));
app.get("/api/v1/panels",async()=>({items:selectablePanels()}));
app.get("/api/v1/ready",async(_req,reply)=>{try{await pool.query("SELECT 1");await verifyPromptLock();return {ready:true}}catch(error){reply.code(503);return {ready:false,reason:error instanceof Error&&error.message.startsWith("prompt_lock_mismatch")?"prompt_lock_mismatch":"dependency_unavailable"}}});
app.post("/api/v1/cases",async(req,reply)=>{
  const key=req.headers["idempotency-key"];if(typeof key!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)){reply.code(400);return envelope(req,"idempotency_key_missing",userMessage("idempotency_key_missing"))}
  if(await dailySpendUsd()>=config.GLOBAL_DAILY_BUDGET_USD){reply.code(402);return envelope(req,"global_budget_exhausted",userMessage("global_budget_exhausted"))}
  try{const body=createCaseSchema.parse(req.body);const sessionId=await session(req,reply);const result=await createCase(sessionId,key,body.indictment,body.panel??config.JUDGE_PANEL);reply.code(result.reused?200:202);return {case_id:result.id,status:"queued",stage:"intake",poll:{href:`/api/v1/cases/${result.id}`,after_ms:1000}}}
  catch(error){if(error instanceof ZodError){reply.code(400);return envelope(req,"validation_failed","Please check the indictment fields.",{fields:error.issues.map(i=>({path:i.path.join("."),rule:i.code,message:i.message}))})}throw error}
});
app.get<{Params:{id:string}}>("/api/v1/cases/:id",async(req,reply)=>{if(!isUuid(req.params.id))return rejectId(req,reply);const result=await getCaseProjection(req.params.id,await session(req,reply));if(!result){reply.code(404);return envelope(req,"case_not_found",userMessage("case_not_found"))}const tag=`W/\"${Buffer.from(JSON.stringify([result.status,result.stage,result.progress,result.totals])).toString("base64url")}\"`;if(req.headers["if-none-match"]===tag){reply.code(304);return}reply.header("ETag",tag);if(!isTerminal(result.status))reply.header("Retry-After","1");return result});
app.get("/api/v1/cases",async(req,reply)=>({items:await listCases(await session(req,reply)),next_cursor:null}));
app.post<{Params:{id:string}}>("/api/v1/cases/:id/retry",async(req,reply)=>{if(!isUuid(req.params.id))return rejectId(req,reply);const key=req.headers["idempotency-key"];if(typeof key!=="string"){reply.code(400);return envelope(req,"idempotency_key_missing",userMessage("idempotency_key_missing"))}const body=req.body as any;if(!body||!["failed_advocates","failed_judges"].includes(body.scope)){reply.code(400);return envelope(req,"validation_failed","Select a valid retry scope.")}await retryFailed(req.params.id,await session(req,reply),body.scope);reply.code(202);return {case_id:req.params.id,status:"queued"}});
app.delete<{Params:{id:string}}>("/api/v1/cases/:id",async(req,reply)=>{if(!isUuid(req.params.id))return rejectId(req,reply);if(!await softDeleteCase(req.params.id,await session(req,reply))){reply.code(404);return envelope(req,"case_not_found",userMessage("case_not_found"))}reply.code(204).send()});
app.setErrorHandler((error,req,reply)=>{
  const mapped=mapError(error);
  if(mapped.statusCode>=500) req.log.error(error); else req.log.warn({code:mapped.code},"request_rejected");
  reply.code(mapped.statusCode).send(envelope(req,mapped.code,userMessage(mapped.code)));
});

const staticRoot=path.resolve("dist/client");if(existsSync(staticRoot)){await app.register(staticPlugin,{root:staticRoot,wildcard:false});app.setNotFoundHandler((_req,reply)=>reply.sendFile("index.html"))}
await app.listen({port:config.PORT,host:"0.0.0.0"});startWorker();
const shutdown=async()=>{stopWorker();await app.close();await pool.end()};process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
