import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestBody, responseFormat } from "../src/structured-output.js";

const request = {
  role: "advocate" as const, instance: 1, stance: "justified" as const,
  system: "system", user: "user", model: "test/model",
  maxOutputTokens: 900, timeoutMs: 1000, temperature: 0.8,
};

test("strict mode derives its schema from the contract", () => {
  const format = responseFormat("advocate", "json_schema") as any;
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  const schema = format.json_schema.schema;
  assert.deepEqual(schema.required.sort(), ["position", "reasoning"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.position.enum, ["justified", "not_justified"]);
  assert.ok(!("$schema" in schema), "providers reject the $schema metadata key");
});

test("strict judge mode describes a decision, not a position", () => {
  const schema = (responseFormat("judge", "json_schema") as any).json_schema.schema;
  assert.deepEqual(schema.required.sort(), ["decision", "reasoning"]);
  assert.ok(!("position" in schema.properties));
});

test("compatible mode remains a plain json_object", () => {
  assert.deepEqual(responseFormat("judge", "json_object"), { type: "json_object" });
});

test("request body includes model, temperature, output limit, and usage request", () => {
  const body = buildRequestBody(request, "json_schema") as any;
  assert.equal(body.model, "test/model");
  assert.equal(body.temperature, 0.8);
  assert.equal(body.max_tokens, 900);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.response_format.type, "json_schema");
});

test("unsupported provider response formats are recognized", async () => {
  const { unsupportedResponseFormat } = await import("../src/structured-output.js");
  assert.equal(unsupportedResponseFormat("Provider does not support response_format json_schema"), true);
  assert.equal(unsupportedResponseFormat("Invalid schema for response_format"), true);
  assert.equal(unsupportedResponseFormat("rate limit exceeded"), false);
});
