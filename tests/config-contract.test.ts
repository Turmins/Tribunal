import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { config } from "../src/config.js";

test("P1-4: every variable in .env.example is consumed by configuration", async () => {
  const example = await readFile(".env.example", "utf8");
  const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]!);
  const unread = declared.filter(name => !(name in config));
  assert.deepEqual(unread, [], `declared but not read: ${unread.join(", ")}`);
});
