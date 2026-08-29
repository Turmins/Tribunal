import { config } from "./config.js";
import { resolveCost } from "./pricing.js";
import { buildRequestBody, unsupportedResponseFormat } from "./structured-output.js";
import type { StructuredMode } from "./structured-output.js";
import type { ModelProvider, ModelRequest, ModelResult } from "./types.js";

const long = (lead:string) => `${lead} The submitted material is treated as the complete evidentiary record. The reasoning distinguishes stated information from assumptions, acknowledges missing context, and tests the strongest competing interpretation. No fact, authority, motive, consequence, or surrounding circumstance is invented. This demonstration response exists to exercise the complete protocol and storage path without making a paid request or pretending to provide professional advice.`;
export class ScriptedProvider implements ModelProvider {
  async complete(request:ModelRequest):Promise<ModelResult>{
    const start=performance.now(); await new Promise(r=>setTimeout(r,30));
    const value=request.role==="advocate"
      ? {position:request.stance,reasoning:long(`Advocate ${request.instance} presents an independent argument for the assigned position.`)}
      : {decision:request.instance===2?"not_justified":"justified",reasoning:long(`Judge ${request.instance} independently weighs all four advocate submissions and rules on the exact question.`)};
    return {rawBody:JSON.stringify(value),finishReason:"stop",provider:"scripted",model:"scripted-v1",inputTokens:100,outputTokens:80,costUsd:0,latencyMs:Math.round(performance.now()-start)};
  }
}
export class OpenRouterProvider implements ModelProvider {
  async complete(request:ModelRequest):Promise<ModelResult>{
    if(!config.OPENROUTER_API_KEY) throw new Error("openrouter_key_missing");
    try {
      const result=await this.call(request,config.STRUCTURED_OUTPUT);
      return {...result,httpAttempts:1,formatFallback:false};
    } catch(error:any){
      // Not every model supports strict schemas. One compatible-mode fallback
      // is cheaper than losing a run; every other failure remains a real failure.
      if(config.STRUCTURED_OUTPUT==="json_schema"&&error?.formatUnsupported){
        console.warn(JSON.stringify({event:"structured_output_fallback",model:request.model,role:request.role}));
        const result=await this.call(request,"json_object");
        return {...result,httpAttempts:2,formatFallback:true};
      }
      throw error;
    }
  }

  private async call(request:ModelRequest,mode:StructuredMode):Promise<ModelResult>{
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),request.timeoutMs); const start=performance.now();
    try {
      const response=await fetch(`${config.OPENROUTER_BASE_URL}/chat/completions`,{
        method:"POST",signal:controller.signal,
        headers:{authorization:`Bearer ${config.OPENROUTER_API_KEY}`,"content-type":"application/json"},
        body:JSON.stringify(buildRequestBody(request,mode)),
      });
      const body=await response.json() as any;
      if(!response.ok){
        const message=body?.error?.message??`provider_${response.status}`;
        const error:any=new Error(message);
        if(response.status===400&&unsupportedResponseFormat(message)) error.formatUnsupported=true;
        else if([400,401,402,403].includes(response.status)) error.retryable=false;
        throw error;
      }
      const inputTokens=Number(body.usage?.prompt_tokens??0),outputTokens=Number(body.usage?.completion_tokens??0);
      // Providers do not always return cost. A zero cost for a live call would
      // defeat budgets, so the fallback price table is used (ARCHITECTURE §17.1).
      const cost=resolveCost(request.role,body.usage?.cost,inputTokens,outputTokens);
      return {rawBody:body.choices?.[0]?.message?.content??"",finishReason:body.choices?.[0]?.finish_reason??"unknown",provider:"openrouter",model:body.model??request.model,inputTokens,outputTokens,costUsd:cost.costUsd,latencyMs:Math.round(performance.now()-start)};
    } finally {clearTimeout(timer)}
  }
}
let active:ModelProvider=config.MODEL_ADAPTER==="openrouter"?new OpenRouterProvider():new ScriptedProvider();

// Limit concurrent outbound calls so a burst of cases cannot become a burst of
// spending and provider 429 responses (ARCHITECTURE §10.3).
let inflight=0; const waiting:Array<()=>void>=[];
async function acquire(){
  if(inflight<config.MAX_INFLIGHT_MODEL_CALLS){inflight++;return}
  await new Promise<void>(resolve=>waiting.push(resolve));
}
function release(){ const next=waiting.shift(); if(next) next(); else inflight--; }

export const provider:ModelProvider={
  async complete(request){ await acquire(); try{ return await active.complete(request) } finally { release() } },
};
/** Replace the provider in tests. Never used by the production path. */
export function setProvider(next:ModelProvider){active=next}
