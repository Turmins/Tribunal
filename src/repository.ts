import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "./config.js";
import { pool, tx } from "./db.js";
import { activeRoles, lensLabelFor, panelOf, promptFor } from "./prompts-registry.js";
import type { PanelName } from "./prompts-registry.js";
import { userMessage } from "./error-messages.js";
import { AppError } from "./errors.js";
import { isTerminal } from "./case-status.js";
import type { Indictment } from "./types.js";

const hash = (value:string) => createHash("sha256").update(value).digest();
export async function ensureSession(cookieToken:string):Promise<string>{
  const cookieHash=hash(`${config.SESSION_SECRET}:${cookieToken}`);
  const found=await pool.query("SELECT id FROM sessions WHERE cookie_hash=$1",[cookieHash]);
  if(found.rowCount) { await pool.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1",[found.rows[0].id]); return found.rows[0].id; }
  return (await pool.query("INSERT INTO sessions(cookie_hash) VALUES($1) RETURNING id",[cookieHash])).rows[0].id;
}
export async function createCase(sessionId:string,key:string,indictment:Indictment,panel:PanelName=config.JUDGE_PANEL){
  // Panel is part of idempotency: otherwise the same key with another panel
  // would silently return an existing case evaluated through different lenses.
  const bodyHash=hash(JSON.stringify({indictment,panel}));
  const existing=await pool.query("SELECT id,indictment_hash FROM cases WHERE idempotency_key=$1",[key]);
  if(existing.rowCount){
    if(!existing.rows[0].indictment_hash.equals(bodyHash)) throw new AppError("idempotency_key_conflict",409);
    return {id:existing.rows[0].id,reused:true};
  }
  const prepared=await Promise.all(activeRoles(panel).map(async role=>({...role,prompt:await promptFor(role.name)})));
  return tx(async client=>{
    const row=(await client.query(`INSERT INTO cases(session_id,defendant,act,question,status,stage,budget_usd,protocol_version,idempotency_key,indictment_hash,deadline_at)
      VALUES($1,$2,$3,$4,'queued','intake',$5,'1.0.0',$6,$7,now()+($8||' milliseconds')::interval) RETURNING id`,
      [sessionId,indictment.defendant,indictment.act,indictment.question,config.MAX_CASE_COST_USD,key,bodyHash,config.CASE_DEADLINE_MS])).rows[0];
    for(const item of prepared) await client.query(`INSERT INTO runs(case_id,role,instance_no,stance,slot,status,prompt_name,prompt_version,prompt_hash)
      VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,[row.id,item.role,item.instance,item.stance,`${item.role}_${item.instance}`,item.name,item.prompt.version,item.prompt.hash]);
    await client.query("INSERT INTO jobs(case_id,kind,state) VALUES($1,'advocates','pending')",[row.id]);
    return {id:row.id,reused:false};
  });
}
export async function claimJob(workerId:string){
  return tx(async client=>{
    const result=await client.query(`SELECT id,case_id,kind FROM jobs WHERE state='pending' AND run_after<=now() AND attempts<$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[config.MAX_JOB_ATTEMPTS]);
    if(!result.rowCount) return null;
    const job=result.rows[0]; await client.query("UPDATE jobs SET state='running',lease_owner=$2,lease_expires_at=now()+interval '2 minutes',attempts=attempts+1 WHERE id=$1",[job.id,workerId]); return job;
  });
}
export async function caseInput(caseId:string){ return (await pool.query("SELECT id,defendant,act,question,budget_usd,spent_usd,deadline_at FROM cases WHERE id=$1",[caseId])).rows[0]; }
export async function stageRuns(caseId:string,role:string){ return (await pool.query("SELECT * FROM runs WHERE case_id=$1 AND role=$2 AND status IN ('pending','failed','aborted') ORDER BY instance_no",[caseId,role])).rows; }
export async function successfulArguments(caseId:string){ return (await pool.query("SELECT r.instance_no,a.position,a.reasoning FROM runs r JOIN advocate_arguments a ON a.run_id=r.id WHERE r.case_id=$1 ORDER BY r.instance_no",[caseId])).rows; }
export async function beginAttempt(runId:string,kind:string){
  return tx(async client=>{
    const run=(await client.query("UPDATE runs SET status='in_flight',attempt_count=attempt_count+1,lease_expires_at=now()+interval '2 minutes' WHERE id=$1 RETURNING attempt_count",[runId])).rows[0];
    return (await client.query("INSERT INTO run_attempts(run_id,attempt_no,attempt_kind,outcome) VALUES($1,$2,$3,'in_flight') RETURNING id",[runId,run.attempt_count,kind])).rows[0].id;
  });
}
export async function succeedRun(run:any,attemptId:string,result:any,normalized:any){
  await tx(async client=>{
    await client.query("UPDATE run_attempts SET outcome='succeeded',input_tokens=$2,output_tokens=$3,cost_usd=$4,latency_ms=$5,finished_at=now() WHERE id=$1",[attemptId,result.inputTokens,result.outputTokens,result.costUsd,result.latencyMs]);
    await client.query("INSERT INTO raw_model_responses(attempt_id,raw_body,parse_mode) VALUES($1,$2,'strict_json')",[attemptId,result.rawBody]);
    await client.query(`UPDATE runs SET status='succeeded',provider=$2,model=$3,input_tokens=$4,output_tokens=$5,cost_usd=$6,latency_ms=$7,normalized_json=$8,finished_at=now(),error_code=NULL,error_message=NULL,lease_expires_at=NULL WHERE id=$1`,[run.id,result.provider,result.model,result.inputTokens,result.outputTokens,result.costUsd,result.latencyMs,normalized]);
    if(run.role==="advocate") await client.query("INSERT INTO advocate_arguments(run_id,case_id,position,reasoning) VALUES($1,$2,$3,$4)",[run.id,run.case_id,normalized.position,normalized.reasoning]);
    else await client.query("INSERT INTO judge_verdicts(run_id,case_id,decision,reasoning) VALUES($1,$2,$3,$4)",[run.id,run.case_id,normalized.decision,normalized.reasoning]);
    await client.query("UPDATE cases SET spent_usd=spent_usd+$2 WHERE id=$1",[run.case_id,result.costUsd]);
  });
}
export async function failAttempt(runId:string,attemptId:string,error:any,last:boolean,usage?:{inputTokens:number;outputTokens:number;costUsd:number}|null){
  await tx(async client=>{
    await client.query("UPDATE run_attempts SET outcome=$2,failure_layer=$3,error_code=$4,error_message=$5,input_tokens=$6,output_tokens=$7,cost_usd=$8,finished_at=now() WHERE id=$1",[attemptId,error.layer?"contract_violation":"provider_error",error.layer??null,error.code??"provider_failure",String(error.message).slice(0,500),usage?.inputTokens??0,usage?.outputTokens??0,usage?.costUsd??0]);
    // A paid but invalid attempt must count toward case spend, otherwise the
    // budget does not limit real expenditure (ARCHITECTURE §17.1).
    if(usage&&usage.costUsd>0) await client.query("UPDATE cases SET spent_usd=spent_usd+$2 WHERE id=(SELECT case_id FROM runs WHERE id=$1)",[runId,usage.costUsd]);
    await client.query(`UPDATE runs SET status=$2,error_code=$3,error_message=$4,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,lease_expires_at=NULL WHERE id=$1`,[runId,last?"failed":"pending",error.code??"provider_failure",userMessage(error.code)]);
  });
}
export async function finishJob(job:any){ await pool.query("UPDATE jobs SET state='done',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]); }
export async function markCase(caseId:string,status:string,stage:string,reason:string|null=null){
  await tx(async client=>{
    await client.query("UPDATE cases SET status=$2,stage=$3,termination_reason=$4,started_at=COALESCE(started_at,now()),finished_at=CASE WHEN $3='finished' THEN now() ELSE NULL END WHERE id=$1",[caseId,status,stage,reason]);
    if(stage==="finished") await abortUnfinishedRuns(client,caseId);
  });
}
/** A run with no result in a terminal case must carry an error instead of appearing pending (ARCHITECTURE A.2 S-8). */
async function abortUnfinishedRuns(client:pg.PoolClient,caseId:string){
  await client.query(`UPDATE runs SET status='aborted',
      error_code=CASE WHEN attempt_count=0 THEN 'stage_not_reached' ELSE 'run_aborted' END,
      error_message=CASE WHEN attempt_count=0 THEN $2 ELSE $3 END,
      finished_at=now(),lease_expires_at=NULL
    WHERE case_id=$1 AND status IN ('pending','in_flight')`,
    [caseId,userMessage("stage_not_reached"),userMessage("run_aborted")]);
}
/** Complete the advocate stage in one transaction. Job closure and transition
 * are inseparable; a crash between them would otherwise leave a case with no job. */
export async function completeAdvocateStage(jobId:string,caseId:string,gatePassed:boolean){
  await tx(async client=>{
    await client.query("UPDATE jobs SET state='done',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[jobId]);
    if(gatePassed){
      await client.query("UPDATE cases SET status='running',stage='advocates_complete',started_at=COALESCE(started_at,now()) WHERE id=$1",[caseId]);
      await client.query("INSERT INTO jobs(case_id,kind,state) VALUES($1,'judges','pending') ON CONFLICT DO NOTHING",[caseId]);
    }else{
      await client.query("UPDATE cases SET status='failed',stage='finished',termination_reason='advocate_gate_failed',finished_at=now() WHERE id=$1",[caseId]);
      await abortUnfinishedRuns(client,caseId);
    }
  });
}
export async function completeJudgeStage(jobId:string,caseId:string,status:string,reason:string|null){
  await tx(async client=>{
    await client.query("UPDATE jobs SET state='done',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[jobId]);
    await client.query("UPDATE cases SET status=$2,stage='finished',termination_reason=$3,finished_at=now() WHERE id=$1",[caseId,status,reason]);
    await abortUnfinishedRuns(client,caseId);
  });
}
/** Fail a run when an attempt could not even be opened. */
export async function failRunWithoutAttempt(runId:string,code:string){
  await pool.query("UPDATE runs SET status='failed',error_code=$2,error_message=$3,finished_at=now(),lease_expires_at=NULL WHERE id=$1",
    [runId,code,userMessage(code)]);
}
/** Move cases with missing jobs or expired deadlines to a terminal status (ARCHITECTURE §15.5 R-4, R-5). */
export async function sweepStuckCases(){
  const overdue=await pool.query(`UPDATE cases SET status='failed',stage='finished',termination_reason='deadline_exceeded',finished_at=now()
    WHERE status IN ('queued','running') AND deadline_at<now() RETURNING id`);
  const exhausted=await pool.query(`UPDATE cases c SET status='failed',stage='finished',termination_reason='stage_error',finished_at=now()
    WHERE c.status IN ('queued','running')
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.case_id=c.id AND j.state IN ('pending','running') AND j.attempts<$1)
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.case_id=c.id AND j.attempts>=$1) RETURNING id`,[config.MAX_JOB_ATTEMPTS]);
  const ids=[...overdue.rows,...exhausted.rows].map(r=>r.id);
  if(ids.length) await tx(async client=>{ for(const id of ids) await abortUnfinishedRuns(client,id); });
  return ids.length;
}
export async function recoverJobs(){ await pool.query("UPDATE jobs SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE state='running' AND lease_expires_at<now()"); await pool.query("UPDATE runs SET status='pending',lease_owner=NULL,lease_expires_at=NULL WHERE status='in_flight' AND (lease_expires_at IS NULL OR lease_expires_at<now())"); }

export async function retryFailed(caseId:string,sessionId:string,scope:"failed_advocates"|"failed_judges"){
  return tx(async client=>{
    const c=(await client.query("SELECT * FROM cases WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL FOR UPDATE",[caseId,sessionId])).rows[0];
    if(!c)throw new AppError("case_not_found",404);
    if(!isTerminal(c.status))throw new AppError("case_not_terminal",409);
    const role=scope==="failed_advocates"?"advocate":"judge";
    if(role==="advocate"){
      const verdicts=Number((await client.query("SELECT count(*) n FROM judge_verdicts WHERE case_id=$1",[caseId])).rows[0].n);
      if(verdicts)throw new AppError("advocates_locked_by_verdicts",409);
    }
    const reset=await client.query("UPDATE runs SET status='pending',normalized_json=NULL,error_code=NULL,error_message=NULL,finished_at=NULL WHERE case_id=$1 AND role=$2 AND status IN ('failed','aborted') AND attempt_count<$3 RETURNING id",[caseId,role,config.MAX_ATTEMPTS_PER_RUN_TOTAL]);
    if(!reset.rowCount)throw new AppError("nothing_to_retry",409);
    const kind=role==="advocate"?"advocates":"judges";
    await client.query("UPDATE cases SET status='queued',stage=$2,termination_reason=NULL,finished_at=NULL,deadline_at=now()+($3||' milliseconds')::interval WHERE id=$1",[caseId,role==="advocate"?"intake":"advocates_complete",config.CASE_DEADLINE_MS]);
    await client.query("INSERT INTO jobs(case_id,kind,state) VALUES($1,$2,'pending') ON CONFLICT DO NOTHING",[caseId,kind]); return {id:caseId};
  });
}
/** Instance-wide daily spend for the global admission gate (ARCHITECTURE §17.3). */
export async function dailySpendUsd(){
  const row=(await pool.query("SELECT COALESCE(SUM(spent_usd),0) AS total FROM cases WHERE created_at>now()-interval '24 hours'")).rows[0];
  return Number(row.total);
}
export async function softDeleteCase(caseId:string,sessionId:string){const result=await pool.query("UPDATE cases SET deleted_at=now() WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL",[caseId,sessionId]);return Boolean(result.rowCount)};

export async function getCaseProjection(caseId:string,sessionId:string){
  const c=(await pool.query("SELECT * FROM cases WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL",[caseId,sessionId])).rows[0]; if(!c)return null;
  const runs=(await pool.query(`SELECT r.*,a.position,a.reasoning AS argument_reasoning,v.decision,v.reasoning AS verdict_reasoning FROM runs r LEFT JOIN advocate_arguments a ON a.run_id=r.id LEFT JOIN judge_verdicts v ON v.run_id=r.id WHERE r.case_id=$1 ORDER BY role,instance_no`,[caseId])).rows;
  const view=(r:any)=>({slot:r.slot,assigned_stance:r.stance,status:r.status,lens_label:lensLabelFor(r.prompt_name),argument:r.role==="advocate"&&r.status==="succeeded"?{position:r.position,reasoning:r.argument_reasoning}:null,verdict:r.role==="judge"&&r.status==="succeeded"?{decision:r.decision,reasoning:r.verdict_reasoning}:null,error:["failed","aborted"].includes(r.status)?{code:r.error_code,message:r.error_message,attempts:r.attempt_count,retryable:r.attempt_count<config.MAX_ATTEMPTS_PER_RUN_TOTAL}:null,meta:r.status==="succeeded"?{prompt_name:r.prompt_name,prompt_version:r.prompt_version,model:r.model,attempts:r.attempt_count,latency_ms:r.latency_ms,input_tokens:r.input_tokens,output_tokens:r.output_tokens,cost_usd:Number(r.cost_usd)}:null});
  const advocates=runs.filter((r:any)=>r.role==="advocate").map(view),judges=runs.filter((r:any)=>r.role==="judge").map(view);
  const panel=panelOf(runs.find((r:any)=>r.role==="judge")?.prompt_name??"");
  return {case_id:c.id,status:c.status,stage:c.stage,panel,termination_reason:c.termination_reason,created_at:c.created_at,finished_at:c.finished_at,protocol_version:c.protocol_version,indictment:{defendant:c.defendant,act:c.act,question:c.question},progress:{advocates_done:advocates.filter((r:any)=>r.status==="succeeded").length,advocates_total:4,judges_done:judges.filter((r:any)=>r.status==="succeeded").length,judges_total:3},advocates,judges,totals:{cost_usd:Number(c.spent_usd),budget_usd:Number(c.budget_usd)}};
}
export async function listCases(sessionId:string){ const rows=(await pool.query(`SELECT c.id,c.created_at,c.status,c.stage,c.defendant,c.question,c.spent_usd,
    (SELECT r.prompt_name FROM runs r WHERE r.case_id=c.id AND r.role='judge' AND r.instance_no=1) AS judge_prompt
    FROM cases c WHERE c.session_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 50`,[sessionId])).rows; return rows.map(r=>({case_id:r.id,created_at:r.created_at,status:r.status,stage:r.stage,indictment_preview:{defendant:r.defendant,question:r.question},panel:panelOf(r.judge_prompt??""),cost_usd:Number(r.spent_usd)})); }
