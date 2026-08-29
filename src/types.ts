export type Stance = "justified" | "not_justified";
export type Role = "advocate" | "judge";
export type RunStatus = "pending" | "in_flight" | "succeeded" | "failed" | "aborted";

export interface Indictment { defendant: string; act: string; question: string }
export interface ModelRequest {
  role: Role; instance: number; stance: Stance | null; system: string; user: string;
  model: string; maxOutputTokens: number; timeoutMs: number; temperature: number;
}
export interface ModelResult {
  rawBody: string; finishReason: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number;
  /** Cost provenance; unknown means at least one HTTP attempt lacks authoritative billing. */
  costSource?: "provider" | "table" | "unknown";
  /** HTTP requests actually issued for this completion; reporting only. */
  httpAttempts?: number;
  /** True when strict json_schema was rejected and json_object was used instead. */
  formatFallback?: boolean;
}
export interface ModelProvider { complete(request: ModelRequest): Promise<ModelResult> }
