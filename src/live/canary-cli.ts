import { OpenRouterProvider } from "../providers.js";
import { ArgError, boolFlag, numberFlag, parseArgs, stringFlag } from "./args.js";
import { CanaryError, formatCanary, runCanary } from "./canary.js";
import { EstimateError } from "./estimate.js";
import { redact, safeErrorMessage } from "./redact.js";
import type { Role } from "../types.js";

/**
 * CLI entry point for the guarded OpenRouter canary.
 *
 * Dry-run is the default and performs no network call. A real call requires
 * `--execute` together with `--max-cost-usd`, a key in the server environment,
 * and a conservative estimate that fits inside the supplied limit.
 */

const FLAGS = [
  "role", "instance", "model", "fixture", "execute", "max-cost-usd",
  "input-price-per-million", "output-price-per-million", "help",
] as const;

const USAGE = `Tribunal OpenRouter canary — one guarded live model call.

Usage:
  npm run live:canary -- [options]

Options:
  --role <advocate>              Role slot to exercise. Only "advocate" is supported.
  --instance <1..4>              Advocate slot number. Default: 1.
  --model <model-id>             OpenRouter model id. Default: the configured advocate model.
  --fixture <fixture-id>         Evaluation fixture to use. Default: the first fixture.
  --max-cost-usd <limit>         Approved ceiling for this single call. Required with --execute.
  --input-price-per-million <n>  Required when --model is not the configured role model.
  --output-price-per-million <n> Required when --model is not the configured role model.
  --execute                      Perform one real, paid model call. Omit for a dry run.
  --help                         Show this message.

Safety:
  Without --execute nothing is sent. The API key is read from the server
  environment only and is never accepted as an argument, printed, or written to
  a report. Prompts and raw responses are never printed. At most one model
  request is issued.
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
    const role = (stringFlag(flags, "role") ?? "advocate") as Role;
    const instanceRaw = numberFlag(flags, "instance") ?? 1;
    if (!Number.isInteger(instanceRaw) || instanceRaw < 1 || instanceRaw > 4) {
      throw new CanaryError("invalid_instance", "--instance must be an integer between 1 and 4.");
    }
    const execute = boolFlag(flags, "execute");
    const maxCostUsd = numberFlag(flags, "max-cost-usd");
    if (flags.has("max-cost-usd") && (maxCostUsd === undefined || maxCostUsd <= 0)) {
      throw new CanaryError("budget_invalid", "--max-cost-usd must be a positive number.");
    }

    const inputPrice = numberFlag(flags, "input-price-per-million");
    const outputPrice = numberFlag(flags, "output-price-per-million");
    const priceOverride = inputPrice !== undefined || outputPrice !== undefined
      ? { inputPerMillion: inputPrice, outputPerMillion: outputPrice }
      : undefined;

    const report = await runCanary(
      {
        role,
        instance: instanceRaw,
        model: stringFlag(flags, "model") ?? process.env["ADVOCATE_MODEL"] ?? "openai/gpt-4o-mini",
        fixtureId: stringFlag(flags, "fixture"),
        execute,
        maxCostUsd,
        priceOverride,
      },
      { provider: new OpenRouterProvider() },
    );

    console.log(redact(formatCanary(report)));
    if (report.outcome && !report.outcome.ok) return 1;
    return 0;
  } catch (error) {
    if (error instanceof EstimateError && error.code === "unknown_model_price") {
      console.error(
        "This model has no price in the shipped table, so its cost cannot be estimated safely.\n" +
        "Supply --input-price-per-million and --output-price-per-million from the provider's own pricing page.\n" +
        "Prices are never guessed: an underestimate would defeat the spending limit.",
      );
      return 2;
    }
    if (error instanceof ArgError || error instanceof CanaryError || error instanceof EstimateError) {
      console.error(redact(error.message));
      return 2;
    }
    console.error(safeErrorMessage(error));
    return 1;
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("live/canary-cli.ts")
  || process.argv[1]?.replace(/\\/g, "/").endsWith("live/canary-cli.js");
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
