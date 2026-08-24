import { z } from "zod";
import { advocateSchema, judgeSchema } from "./schemas.js";
import type { ModelRequest, Role } from "./types.js";

export type StructuredMode = "json_schema" | "json_object";

/**
 * JSON Schema is derived from the same Zod contracts that validate responses.
 * One definition serves provider requests, validation, and types
 * (ARCHITECTURE §13.1), preventing request and validation schemas from drifting.
 */
function contractSchema(role: Role): Record<string, unknown> {
  const generated = z.toJSONSchema(role === "advocate" ? advocateSchema : judgeSchema) as Record<string, unknown>;
  // Providers reject the $schema metadata key inside json_schema.schema.
  const { $schema: _ignored, ...rest } = generated;
  return rest;
}

export function responseFormat(role: Role, mode: StructuredMode): Record<string, unknown> {
  if (mode === "json_object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name: `tribunal_${role}`, strict: true, schema: contractSchema(role) },
  };
}

export function buildRequestBody(request: ModelRequest, mode: StructuredMode): Record<string, unknown> {
  return {
    model: request.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    response_format: responseFormat(request.role, mode),
    usage: { include: true },
  };
}

/**
 * Not every OpenRouter model supports strict schemas. Distinguish format
 * rejection from other 4xx responses so one compatible-mode retry is possible
 * without spending every run attempt.
 */
export function unsupportedResponseFormat(message: string): boolean {
  return /response_format|json_schema|structured output/i.test(message);
}
