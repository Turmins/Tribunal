import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { provider } from "./providers.js";
import { promptFor } from "./prompts-registry.js";
import { ContractError, isRetryable, validateModelOutput } from "./schemas.js";
import { judgeStageOutcome } from "./case-status.js";
import { buildJudgeEvidence, wrapIndictment } from "./prompt-boundaries.js";
import { MAX_OUTPUT_TOKENS, estimateTokens, worstCaseJudgeStage } from "./pricing.js";
import { beginAttempt, caseInput, claimJob, completeAdvocateStage, completeJudgeStage, failAttempt, failRunWithoutAttempt, finishJob, markCase, recoverJobs, stageRuns, succeedRun, successfulArguments, sweepStuckCases } from "./repository.js";

const workerId=randomUUID(); let timer:NodeJS.Timeout|undefined; let active=false;
const wrap=(c:any)=>wrapIndictment(c);
async function execute(run:any,c:any,evidence:string){
  try{
    const prompt=await promptFor(run.prompt_name);
    // The prompt may have changed between case creation and execution. A result
    // from a prompt other than the one recorded on the run is unauditable (G-03, AC-24).
    if(run.prompt_hash&&!prompt.hash.equals(run.prompt_hash)){
      await failRunWithoutAttempt(run.id,"prompt_drift"); return false;
    }
    const max=Math.min(config.MAX_ATTEMPTS_PER_RUN_AUTO,config.MAX_ATTEMPTS_PER_RUN_TOTAL-run.attempt_count);
    if(max<=0){ await failRunWithoutAttempt(run.id,"retry_budget_exhausted"); return false; }
    for(let n=0;n<max;n++){
      const attemptId=await beginAttempt(run.id,n===0?"initial":"repair");
      // Calling and validation are separate: if a returned response violates the
      // contract, its paid tokens must still be accounted for (ARCHITECTURE §17.1).
      let billed:{inputTokens:number;outputTokens:number;costUsd:number}|null=null;
      try{
        const result=await provider.complete({role:run.role,instance:run.instance_no,stance:run.stance,system:prompt.text,user:`${wrap(c)}${evidence}`,model:run.role==="judge"?config.JUDGE_MODEL:config.ADVOCATE_MODEL,maxOutputTokens:MAX_OUTPUT_TOKENS[run.role as "advocate"|"judge"],timeoutMs:run.role==="judge"?config.JUDGE_TIMEOUT_MS:config.ADVOCATE_TIMEOUT_MS,temperature:run.role==="judge"?config.TEMPERATURE_JUDGE:config.TEMPERATURE_ADVOCATE});
        billed={inputTokens:result.inputTokens,outputTokens:result.outputTokens,costUsd:result.costUsd};
        if(result.finishReason==="length") throw new ContractError("L0","truncated_response");
        const normalized=validateModelOutput(result.rawBody,run.role,run.stance); await succeedRun(run,attemptId,result,normalized); return true;
      }catch(error:any){
        // Prompt leaks and key failures cannot be repaired by retrying; more
        // attempts only spend money (ARCHITECTURE §15.2).
        const last=n===max-1||!isRetryable(error);
        await failAttempt(run.id,attemptId,error,last,billed);
        if(last) return false;
      }
    }
    return false;
  }catch(error:any){
    // An exception outside the attempt loop must not crash the stage or strand the case.
    console.error(JSON.stringify({event:"run_error",run_id:run.id,role:run.role,instance:run.instance_no,message:error instanceof Error?error.message:String(error)}));
    await failRunWithoutAttempt(run.id,"provider_failure").catch(()=>{});
    return false;
  }
}
async function processJob(job:any){
  const c=await caseInput(job.case_id); if(!c){await finishJob(job);return}
  if(new Date(c.deadline_at)<new Date()){await markCase(c.id,"failed","finished","deadline_exceeded");await finishJob(job);return}
  if(job.kind==="advocates"){
    await markCase(c.id,"running","advocates"); const runs=await stageRuns(c.id,"advocate"); await Promise.all(runs.map((r:any)=>execute(r,c,""))); const args=await successfulArguments(c.id);
    await completeAdvocateStage(job.id,c.id,args.length===4); return;
  }
  await markCase(c.id,"running","judges"); const args=await successfulArguments(c.id); if(args.length!==4){await completeJudgeStage(job.id,c.id,"failed","advocate_gate_failed");return}
  const evidence=buildJudgeEvidence(args as any);
  // Budget gate: start the entire stage or do not start it at all. Partial launch
  // would introduce a judge-selection rule outside the protocol (ARCHITECTURE §16.3).
  const projected=worstCaseJudgeStage(estimateTokens(`${wrap(c)}${evidence}`));
  if(Number(c.spent_usd)+projected>Number(c.budget_usd)){
    await completeJudgeStage(job.id,c.id,"failed","budget_exhausted"); return;
  }
  const runs=await stageRuns(c.id,"judge"); const results=await Promise.all(runs.map((r:any)=>execute(r,c,evidence)));
  const outcome=judgeStageOutcome(results.filter(Boolean).length);
  await completeJudgeStage(job.id,c.id,outcome.status,outcome.reason);
}
export async function tick(){if(active)return;active=true;try{await recoverJobs();await sweepStuckCases();const job=await claimJob(workerId);if(job)await processJob(job)}catch(error){console.error(JSON.stringify({event:"worker_error",message:error instanceof Error?error.message:String(error)}))}finally{active=false}}
export function startWorker(){timer=setInterval(()=>void tick(),config.WORKER_POLL_MS);void tick()}
export function stopWorker(){if(timer)clearInterval(timer)}
