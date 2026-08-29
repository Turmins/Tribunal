import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { OpenRouterProvider } from "../providers.js";
import { ArgError, boolFlag, listFlag, numberFlag, parseArgs, stringFlag } from "./args.js";
import { EstimateError } from "./estimate.js";
import { EvaluationError, runEvaluation } from "./evaluation.js";
import { redact, safeErrorMessage } from "./redact.js";
import { buildJsonReport, renderMarkdown, stableStringify } from "./report.js";
import type { ExecutionKind } from "./report.js";
import type { Role } from "../types.js";

/**
 * CLI entry point for the deterministic evaluation harness.
 *
 * Dry-run is the default and needs no API key. Real execution requires
 * `--execute` and a total `--max-cost-usd` that bounds the whole run.
 */

const FLAGS = [
  "models", "roles", "fixtures", "execute", "max-cost-usd", "concurrency",
  "input-price-per-million", "output-price-per-million", "out-dir", "help",
] as const;

export const DEFAULT_RESULTS_DIR = path.join("evaluation", "results");

const USAGE = `Tribunal model evaluation harness — deterministic comparison on a fixed corpus.

Usage:
  npm run eval:models -- --models <model-a,model-b> [options]

Options:
  --models <a,b>                 Comma-separated OpenRouter model ids. Required.
  --roles <advocate,judge>       Roles to evaluate. Default: both.
  --fixtures <id,id>             Fixture ids. Default: every fixture.
  --max-cost-usd <limit>         Total approved spend for the whole run. Required with --execute.
  --concurrency <n>              Parallel calls, capped by MAX_INFLIGHT_MODEL_CALLS. Default: 1.
  --input-price-per-million <n>  Required for models absent from the shipped price table.
  --output-price-per-million <n> Required for models absent from the shipped price table.
  --out-dir <path>               Where reports are written. Default: ${DEFAULT_RESULTS_DIR}
  --execute                      Perform real, paid model calls. Omit for a dry run.
  --help                         Show this message.

Safety:
  Without --execute nothing is sent and no key is needed. Spending stops before
  any call whose conservative maximum does not fit the remaining budget. Reports
  contain derived metrics only: no prompt text, no raw response, no reasoning
  text, and never a credential.
`;

export async function main(argv: readonly string[]): Promise<number> {
  let flags;
  try {
    flags = parseArgs(argv, FLAGS as unknown as string[]);
  } catch (error) {
    if (error instanceof ArgError) { console.error(redact(error.message)); return 2; }
    throw error;
  }

  if (boolFlag(flags, "help")) { console.log(USAGE); return 0; }

  try {
    const models = listFlag(flags, "models");
    if (!models) throw new EvaluationError("models_required", "--models is required, for example --models openai/gpt-4o-mini");
    const roles = listFlag(flags, "roles") as Role[] | undefined;
    if (roles) {
      for (const role of roles) {
        if (role !== "advocate" && role !== "judge") {
          throw new EvaluationError("invalid_role", `Unknown role: ${role}. Valid roles are advocate and judge.`);
        }
      }
    }
    const execute = boolFlag(flags, "execute");
    const maxCostUsd = numberFlag(flags, "max-cost-usd");
    if (flags.has("max-cost-usd") && (maxCostUsd === undefined || maxCostUsd <= 0)) {
      throw new EvaluationError("budget_invalid", "--max-cost-usd must be a positive number.");
    }
    const inputPrice = numberFlag(flags, "input-price-per-million");
    const outputPrice = numberFlag(flags, "output-price-per-million");

    const run = await runEvaluation(
      {
        models,
        roles,
        fixtureIds: listFlag(flags, "fixtures"),
        execute,
        maxCostUsd,
        concurrency: numberFlag(flags, "concurrency"),
        priceOverride: inputPrice !== undefined || outputPrice !== undefined
          ? { inputPerMillion: inputPrice, outputPerMillion: outputPrice }
          : undefined,
      },
      { provider: new OpenRouterProvider() },
    );

    const execution: ExecutionKind = run.mode === "dry-run" ? "dry-run" : "real-execution";
    const report = buildJsonReport({ run, execution, generatedAt: new Date().toISOString() });
    const outDir = stringFlag(flags, "out-dir") ?? DEFAULT_RESULTS_DIR;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(outDir, `${stamp}-${execution}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(`${base}.json`, redact(stableStringify(report)), "utf8");
    await writeFile(`${base}.md`, redact(renderMarkdown(report)), "utf8");

    console.log(redact(renderMarkdown(report)));
    console.log(`Reports written to ${base}.json and ${base}.md`);
    if (run.mode === "dry-run") {
      console.log("NO MODEL REQUEST WAS SENT. Add --execute and --max-cost-usd <limit> to run for real.");
    }
    if (run.stoppedReason) {
      console.error(`Evaluation stopped early: ${run.stoppedReason}`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof EstimateError && error.code === "unknown_model_price") {
      console.error(
        "At least one model has no price in the shipped table, so its cost cannot be estimated safely.\n" +
        "Supply --input-price-per-million and --output-price-per-million from the provider's own pricing page.\n" +
        `The table currently covers only ${config.ADVOCATE_MODEL} (advocate) and ${config.JUDGE_MODEL} (judge).`,
      );
      return 2;
    }
    if (error instanceof ArgError || error instanceof EvaluationError || error instanceof EstimateError) {
      console.error(redact(error.message));
      return 2;
    }
    console.error(safeErrorMessage(error));
    return 1;
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("live/eval-cli.ts")
  || process.argv[1]?.replace(/\\/g, "/").endsWith("live/eval-cli.js");
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
