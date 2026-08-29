import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SECRET = "sk-or-v1-cli-secret-value-that-must-never-be-printed";
process.env.OPENROUTER_API_KEY = SECRET;

const canary = await import("../src/live/canary-cli.js");
const evaluate = await import("../src/live/eval-cli.js");
const { forbidFetch } = await import("./helpers/live.js");

/** Run a CLI entry point with stdout and stderr captured. */
async function capture(main: (argv: string[]) => Promise<number>, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const warn = console.warn;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  try {
    const code = await main(argv);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log; console.error = error; console.warn = warn;
  }
}

const assertNoSecret = (result: { stdout: string; stderr: string }) => {
  assert.ok(!result.stdout.includes(SECRET), "the key must never reach stdout");
  assert.ok(!result.stderr.includes(SECRET), "the key must never reach stderr");
  assert.ok(!/authorization/i.test(result.stdout + result.stderr), "no Authorization header may be printed");
};

test("cli: the canary dry run makes no network call and prints no secret", async () => {
  const guard = forbidFetch();
  try {
    const result = await capture(canary.main, []);
    assert.equal(result.code, 0);
    assert.equal(guard.called(), 0, "a dry run must not touch the network");
    assert.match(result.stdout, /mode: dry-run/);
    assert.match(result.stdout, /NO NETWORK CALL WAS PERFORMED/);
    assertNoSecret(result);
  } finally { guard.restore(); }
});

test("cli: the canary refuses --execute without a limit and sends nothing", async () => {
  const guard = forbidFetch();
  try {
    const result = await capture(canary.main, ["--execute"]);
    assert.equal(result.code, 2);
    assert.equal(guard.called(), 0);
    assert.match(result.stderr, /--max-cost-usd is required/);
    assertNoSecret(result);
  } finally { guard.restore(); }
});

test("cli: the canary refuses an invalid limit, an unknown flag, and a credential flag", async () => {
  const guard = forbidFetch();
  try {
    for (const argv of [["--execute", "--max-cost-usd", "0"], ["--execute", "--max-cost-usd", "abc"]]) {
      const result = await capture(canary.main, argv);
      assert.equal(result.code, 2, `expected refusal for ${argv.join(" ")}`);
      assertNoSecret(result);
    }
    const unknown = await capture(canary.main, ["--exceute"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown flag/);

    const credential = await capture(canary.main, ["--api-key", SECRET]);
    assert.equal(credential.code, 2);
    assert.match(credential.stderr, /Credentials are read from the server environment only/);
    assertNoSecret(credential);
    assert.equal(guard.called(), 0);
  } finally { guard.restore(); }
});

test("cli: an unpriced model is refused rather than estimated from a guess", async () => {
  const guard = forbidFetch();
  try {
    const result = await capture(canary.main, ["--model", "vendor/unknown-model"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no price in the shipped table/);
    assert.equal(guard.called(), 0);
  } finally { guard.restore(); }
});

test("cli: the evaluation dry run writes both reports and calls nothing", async () => {
  const guard = forbidFetch();
  const dir = await mkdtemp(path.join(tmpdir(), "tribunal-eval-"));
  try {
    const result = await capture(evaluate.main, [
      "--models", "openai/gpt-4o-mini", "--roles", "advocate", "--out-dir", dir,
    ]);
    assert.equal(result.code, 0);
    assert.equal(guard.called(), 0, "a dry run must not touch the network");
    assert.match(result.stdout, /NO MODEL REQUEST WAS SENT/);
    assertNoSecret(result);

    const files = await readdir(dir);
    assert.equal(files.filter(f => f.endsWith(".json")).length, 1);
    assert.equal(files.filter(f => f.endsWith(".md")).length, 1);
    for (const file of files) {
      const body = await readFile(path.join(dir, file), "utf8");
      assert.ok(!body.includes(SECRET), `${file} must not contain the key`);
      assert.ok(!body.includes("<<<INDICTMENT_START>>>"), `${file} must not contain prompt payloads`);
    }
    const json = JSON.parse(await readFile(path.join(dir, files.find(f => f.endsWith(".json"))!), "utf8"));
    assert.equal(json.execution, "dry-run");
    assert.equal(json.verdicts_combined, false);
    assert.ok(json.planned.calls > 0);
  } finally { guard.restore(); }
});

test("cli: the evaluation refuses --execute without a limit", async () => {
  const guard = forbidFetch();
  try {
    const result = await capture(evaluate.main, ["--models", "openai/gpt-4o-mini", "--roles", "advocate", "--execute"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--max-cost-usd is required/);
    assert.equal(guard.called(), 0);
  } finally { guard.restore(); }
});

test("cli: the evaluation requires at least one model", async () => {
  const result = await capture(evaluate.main, []);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--models is required/);
});

test("cli: help text documents the safety defaults without revealing secrets", async () => {
  for (const main of [canary.main, evaluate.main]) {
    const result = await capture(main, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--execute/);
    assert.match(result.stdout, /--max-cost-usd/);
    assertNoSecret(result);
  }
});
