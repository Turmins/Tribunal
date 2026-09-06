import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { OpenRouterProvider } from "../providers.js";
import { ArgError, boolFlag, listFlag, numberFlag, parseArgs, stringFlag } from "./args.js";
import { EstimateError } from "./estimate.js";
import type { PriceOverride } from "./estimate.js";
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
  "input-price-per-million", "output-price-per-million", "prices", "out-dir", "help",
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
                                These two flags are valid only with one model.
  --prices <model=in:out,...>    Per-model prices for a multi-model comparison.
  --out-dir <path>               Where reports are written. Default: ${DEFAULT_RESULTS_DIR}
  --execute                      Perform real, paid model calls. Omit for a dry run.
  --help                         Show this message.

Safety:
  Without --execute nothing is sent and no key is needed. Spending stops before
  any call whose conservative maximum does not fit the remaining budget. Reports
  contain derived metrics only: no prompt text, no raw response, no reasoning
  text, and never a credential.
`;

/** Parse `model=input:output` entries without treating ':' inside a model id as a separator. */
export function parseModelPrices(raw: string): Readonly<Record<string, PriceOverride>> {
  const prices: Record<string, PriceOverride> = {};
  for (const entry of raw.split(",").map(value => value.trim()).filter(Boolean)) {
    const separator = entry.lastIndexOf("=");
    if (separator <= 0) {
      throw new EvaluationError("price_map_invalid", "--prices entries must use model=input:output.");
    }
    const model = entry.slice(0, separator).trim();
    const parts = entry.slice(separator + 1).split(":");
    if (parts.length !== 2 || parts.some(value => !/^\d+(\.\d+)?$/.test(value.trim()))) {
      throw new EvaluationError("price_map_invalid", `Invalid price entry for ${model}; expected model=input:output.`);
    }
    if (Object.hasOwn(prices, model)) {
      throw new EvaluationError("duplicate_price", `Duplicate price entry for model: ${model}`);
    }
    prices[model] = { inputPerMillion: Number(parts[0]), outputPerMillion: Number(parts[1]) };
  }
  if (Object.keys(prices).length === 0) {
    throw new EvaluationError("price_map_invalid", "--prices requires at least one model=input:output entry.");
  }
  return prices;
}

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
    const mappedPricesRaw = stringFlag(flags, "prices");
    const legacyPriceRequested = inputPrice !== undefined || outputPrice !== undefined;
    if (mappedPricesRaw !== undefined && legacyPriceRequested) {
      throw new EvaluationError("price_flags_conflict", "Use either --prices or the single-model price flags, not both.");
    }
    if (legacyPriceRequested && (inputPrice === undefined || outputPrice === undefined)) {
      throw new EvaluationError("price_invalid", "Both --input-price-per-million and --output-price-per-million are required.");
    }
    if (legacyPriceRequested && models.length !== 1) {
      throw new EvaluationError(
        "single_model_prices_only",
        "The input/output price flags apply to one model only. Use --prices model=input:output,... for multiple models.",
      );
    }
    const priceOverrides = mappedPricesRaw !== undefined
      ? parseModelPrices(mappedPricesRaw)
      : legacyPriceRequested
        ? { [models[0]!]: { inputPerMillion: inputPrice, outputPerMillion: outputPrice } }
        : undefined;
    if (priceOverrides) {
      for (const model of Object.keys(priceOverrides)) {
        if (!models.includes(model)) {
          throw new EvaluationError("price_model_not_selected", `Price supplied for an unselected model: ${model}`);
        }
      }
    }
    const concurrency = numberFlag(flags, "concurrency");
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
      throw new EvaluationError("concurrency_invalid", "--concurrency must be a positive integer.");
    }

    const run = await runEvaluation(
      {
        models,
        roles,
        fixtureIds: listFlag(flags, "fixtures"),
        execute,
        maxCostUsd,
        concurrency,
        priceOverrides,
      },
      { provider: new OpenRouterProvider() },
    );

    const execution: ExecutionKind = run.mode === "dry-run"
      ? "dry-run"
      : run.callCount === 0
        ? "execution-blocked"
        : "real-execution";
    const report = buildJsonReport({ run, execution, generatedAt: new Date().toISOString() });
    const outDir = stringFlag(flags, "out-dir") ?? DEFAULT_RESULTS_DIR;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(outDir, `${stamp}-${execution}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(`${base}.json`, redact(stableStringify(report)), "utf8");
    await writeFile(`${base}.md`, redact(renderMarkdown(report)), "utf8");

    console.log(redact(renderMarkdown(report)));
    console.log(redact(`Reports written to ${base}.json and ${base}.md`));
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
        "For one model, supply --input-price-per-million and --output-price-per-million.\n" +
        "For multiple models, supply --prices model=input:output,... using the provider's own pricing page.\n" +
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
