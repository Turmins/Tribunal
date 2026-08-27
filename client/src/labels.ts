export interface CaseLabelInput {
  status: string;
  stage: string;
  progress: { advocates_done: number; judges_done: number };
}

/**
 * Human-readable case status. Terminal status is checked before stage because
 * partial and failed cases both use the "finished" stage. Checking the stage
 * first previously labeled cases with no decisions as "Review complete".
 */
export function caseLabel(view: CaseLabelInput): string {
  switch (view.status) {
    case "completed": return "Review complete";
    case "partial": return `Partially complete: received ${view.progress.judges_done} of 3 decisions`;
    case "failed": return "Review failed";
    case "cancelled": return "Review cancelled";
  }
  switch (view.stage) {
    case "advocates": return `Advocates: ${view.progress.advocates_done} of 4 ready`;
    case "advocates_complete": return "Arguments collected; starting three judges";
    case "judges": return `Judges: ${view.progress.judges_done} of 3 ready`;
    default: return "Case accepted; preparing four independent arguments";
  }
}

export interface HistoryStateInput {
  isSuccess: boolean;
  isError: boolean;
}

/**
 * Message shown when the previous-cases list has nothing to render.
 *
 * "There are no cases" is a factual claim about the session, so it requires a
 * confirmed successful response. Every other state is unknown rather than
 * empty: a request that is queued, in flight, or waiting between retries
 * reports loading, and a failed request reports the failure. Deciding this from
 * an in-flight flag alone was wrong, because a query waiting to retry is
 * neither actively fetching nor finished.
 */
export function historyLabel(state: HistoryStateInput): string {
  if (state.isError) return "Unable to load previous cases.";
  if (!state.isSuccess) return "Loading previous cases…";
  return "There are no cases in this browser session yet.";
}
