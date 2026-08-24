import { z } from "zod";
import type { Stance } from "./types.js";
import { stripBoundaries } from "./prompt-boundaries.js";
import { SELECTABLE_PANELS } from "./prompts-registry.js";

const clean = (value: string) => stripBoundaries(value.normalize("NFC").replace(/[\u200B-\u200F\uFEFF]/g, ""));
const noControls = (value: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const text = (min: number, max: number) => z.string().transform(clean).pipe(z.string().min(min).max(max).refine(noControls, "control_characters").refine(v => !/\n{21}/.test(v), "excessive_whitespace"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Validate case identifiers before database access; otherwise the driver throws a 500. */
export const isUuid = (value: unknown): boolean => typeof value === "string" && UUID.test(value);

export const indictmentSchema = z.object({ defendant: text(2,200), act: text(10,2000), question: text(5,300) }).strict();
export const createCaseSchema = z.object({
  indictment: indictmentSchema,
  panel: z.enum(SELECTABLE_PANELS).optional(),
}).strict();
export const advocateSchema = z.object({ position: z.enum(["justified","not_justified"]), reasoning: z.string().trim().min(200).max(4000) }).strict();
export const judgeSchema = z.object({ decision: z.enum(["justified","not_justified"]), reasoning: z.string().trim().min(200).max(4000) }).strict();

export class ContractError extends Error { constructor(public layer: string, public code: string) { super(code); } }

/**
 * System-prompt integrity marker. If this value appears in a response, the model
 * reproduced instructions; retrying is both useless and unsafe
 * (ARCHITECTURE §13.2 layer L7, §15.2).
 */
export const CANARY = "TRIBUNAL-CANARY-7Q4X2M9K";

/** Prompt leaks and provider key failures cannot be repaired by retrying. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ContractError) return error.layer !== "L7";
  if (error && typeof error === "object" && (error as { retryable?: unknown }).retryable === false) return false;
  return true;
}

const DECISIONS = ["justified", "not_justified"] as const;
/** Shape without length or enum constraints: separate layers provide separate diagnoses. */
const advocateShape = z.object({ position: z.string(), reasoning: z.string() }).strict();
const judgeShape = z.object({ decision: z.string(), reasoning: z.string() }).strict();

function exactlyOneObject(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(cleaned); } catch { throw new ContractError("L1", "unparseable_output"); }
}

/**
 * Layers run in order and each produces its own diagnosis. Collapsing length,
 * role confusion, and schema failures into one code makes prompt-quality metrics
 * useless because the required fix is no longer visible (ARCHITECTURE §13.2).
 */
export function validateModelOutput(raw: string, role: "advocate" | "judge", stance: Stance | null) {
  // L0 — transport
  if (!raw.trim()) throw new ContractError("L0", "empty_response");
  // L7 — detect prompt leaks in the raw body before considering format
  if (raw.includes(CANARY)) throw new ContractError("L7", "prompt_leak");
  // L1 — extraction
  const value = exactlyOneObject(raw);

  const foreign = role === "advocate" ? "decision" : "position";
  // L6 — role-contract confusion: an advocate decided or a judge took a position
  if (value && typeof value === "object" && foreign in (value as object)) {
    throw new ContractError("L6", "role_confusion");
  }
  // L2 — shape: required keys, types, and no additional properties
  const parsed = role === "advocate" ? advocateShape.safeParse(value) : judgeShape.safeParse(value);
  if (!parsed.success) throw new ContractError("L2", "schema_violation");
  const decision = role === "advocate"
    ? (parsed.data as { position: string }).position
    : (parsed.data as { decision: string }).decision;
  const reasoning = parsed.data.reasoning;
  // L3 — enum values
  if (!(DECISIONS as readonly string[]).includes(decision)) throw new ContractError("L3", "enum_violation");
  // L4 — length
  const trimmed = reasoning.trim();
  if (trimmed.length < 200 || trimmed.length > 4000) throw new ContractError("L4", "length_violation");
  // L5 — assigned-role consistency
  if (role === "advocate" && decision !== stance) throw new ContractError("L5", "role_violation");

  return role === "advocate"
    ? { position: decision as Stance, reasoning: trimmed }
    : { decision: decision as Stance, reasoning: trimmed };
}
