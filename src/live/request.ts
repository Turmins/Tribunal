import { config } from "../config.js";
import { MAX_OUTPUT_TOKENS } from "../pricing.js";
import { buildJudgeEvidence, wrapIndictment } from "../prompt-boundaries.js";
import { activeRoles, promptFor } from "../prompts-registry.js";
import type { AdvocateScheme, PanelName } from "../prompts-registry.js";
import type { ModelRequest, Role, Stance } from "../types.js";
import type { Fixture } from "./fixtures.js";

/**
 * Build the exact request the worker would send for one role slot.
 *
 * The guarded live tools must exercise the shipped prompts, boundaries, and
 * limits rather than an approximation of them, so composition goes through the
 * production registry and the production wrapper helpers. Nothing here creates
 * a case, writes to the database, or advances the 4+3 protocol: a slot is
 * rendered in isolation for measurement.
 */

export interface SlotRequest {
  readonly request: ModelRequest;
  readonly promptName: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly lensLabel: string | null;
  readonly slot: string;
}

export interface BuildOptions {
  readonly role: Role;
  readonly instance: number;
  readonly fixture: Fixture;
  readonly model: string;
  readonly panel?: PanelName;
  readonly scheme?: AdvocateScheme;
}

export async function buildSlotRequest(options: BuildOptions): Promise<SlotRequest> {
  const panel = options.panel ?? config.JUDGE_PANEL;
  const scheme = options.scheme ?? config.ADVOCATE_SCHEME;
  const slot = activeRoles(panel, scheme)
    .find(s => s.role === options.role && s.instance === options.instance);
  if (!slot) throw new Error(`unknown slot: ${options.role} ${options.instance}`);

  const prompt = await promptFor(slot.name);
  // Judges read the fixture's fixed reference arguments, so every model under
  // comparison is given identical evidence. Advocates read the indictment alone.
  const evidence = options.role === "judge"
    ? buildJudgeEvidence(options.fixture.reference_arguments as { instance_no: number; position: string; reasoning: string }[])
    : "";

  const request: ModelRequest = {
    role: options.role,
    instance: options.instance,
    stance: slot.stance as Stance | null,
    system: prompt.text,
    user: `${wrapIndictment(options.fixture.indictment)}${evidence}`,
    model: options.model,
    maxOutputTokens: MAX_OUTPUT_TOKENS[options.role],
    timeoutMs: options.role === "judge" ? config.JUDGE_TIMEOUT_MS : config.ADVOCATE_TIMEOUT_MS,
    temperature: options.role === "judge" ? config.TEMPERATURE_JUDGE : config.TEMPERATURE_ADVOCATE,
  };

  return {
    request,
    promptName: slot.name,
    promptVersion: prompt.version,
    promptHash: prompt.hash.toString("hex"),
    lensLabel: prompt.label,
    slot: `${options.role}_${options.instance}`,
  };
}
