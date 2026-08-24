import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { INDICTMENT, createScratchDatabase, databaseReachable, scenarioProvider } from "./helpers/db.js";

const reachable = await databaseReachable();

if (!reachable) {
  test("integration tests skipped: PostgreSQL is unavailable", { skip: "no database" }, () => {});
} else {
  const scratch = await createScratchDatabase();
  process.env.DATABASE_URL = scratch.url;
  process.env.SESSION_SECRET = "integration-secret-at-least-16";

  const repo = await import("../src/repository.js");
  const worker = await import("../src/worker.js");
  const providers = await import("../src/providers.js");
  const db = await import("../src/db.js");

  after(async () => { await db.pool.end(); await scratch.drop(); });

  const TERMINAL = ["completed", "partial", "failed", "cancelled"];

  async function runCase(script: Parameters<typeof scenarioProvider>[0]) {
    const scenario = scenarioProvider(script);
    providers.setProvider(scenario.provider as never);
    const session = await repo.ensureSession(randomUUID());
    const created = await repo.createCase(session, randomUUID(), INDICTMENT);
    for (let i = 0; i < 40; i++) {
      await worker.tick();
      const view = await repo.getCaseProjection(created.id, session);
      if (view && TERMINAL.includes(view.status)) return { view, calls: scenario.calls, session, id: created.id };
    }
    throw new Error("case did not reach a terminal status");
  }

  async function startCase(script: Parameters<typeof scenarioProvider>[0]) {
    const scenario = scenarioProvider(script);
    providers.setProvider(scenario.provider as never);
    const session = await repo.ensureSession(randomUUID());
    const created = await repo.createCase(session, randomUUID(), INDICTMENT);
    return { id: created.id, session, calls: scenario.calls };
  }

  async function drive(id: string, session: string, limit = 40) {
    for (let i = 0; i < limit; i++) {
      await worker.tick();
      const view = await repo.getCaseProjection(id, session);
      if (view && TERMINAL.includes(view.status)) return view;
    }
    return await repo.getCaseProjection(id, session);
  }

  const allFail = (roles: string[]) =>
    Object.fromEntries(roles.map(r => [r, { fail: "provider unavailable" }]));

  test("P0-3: terminal cases have no run without either a result or an error", async () => {
    const { view } = await runCase(allFail(["advocate:1", "advocate:2", "advocate:3", "advocate:4"]));
    assert.equal(view.status, "failed");
    const blank = [...view.advocates, ...view.judges]
      .filter((r: any) => !r.argument && !r.verdict && !r.error);
    assert.equal(blank.length, 0, `runs without result or error: ${blank.length}`);
  });

  test("protocol: judges are not called when the 4/4 advocate gate fails", async () => {
    const { view, calls } = await runCase(allFail(["advocate:1"]));
    assert.equal(view.status, "failed");
    assert.equal(calls.filter(c => c.startsWith("judge")).length, 0);
    assert.equal(view.judges.filter((j: any) => j.verdict).length, 0);
  });

  test("P0-1: failure of all three judges produces failed, not partial", async () => {
    const { view } = await runCase(allFail(["judge:1", "judge:2", "judge:3"]));
    assert.equal(view.status, "failed");
    assert.equal(view.judges.filter((j: any) => j.verdict).length, 0);
    assert.equal(view.judges.filter((j: any) => j.error).length, 3);
  });

  test("P0-1: one failed judge produces partial with two visible decisions", async () => {
    const { view } = await runCase(allFail(["judge:2"]));
    assert.equal(view.status, "partial");
    assert.equal(view.judges.filter((j: any) => j.verdict).length, 2);
    assert.equal(view.judges.filter((j: any) => j.error).length, 1);
    for (const j of view.judges) assert.ok(!(j.verdict && j.error), "verdict and error are mutually exclusive");
  });

  test("priority 2: retrying a completed case reports nothing_to_retry", async () => {
    const { id, session } = await runCase({});
    await assert.rejects(
      () => repo.retryFailed(id, session, "failed_judges"),
      (error: any) => error.code === "nothing_to_retry",
      "a completed case is terminal: no roles are available to retry");
  });

  test("protocol: advocate retries are blocked after decisions exist", async () => {
    const { id, session } = await runCase({});
    await assert.rejects(
      () => repo.retryFailed(id, session, "failed_advocates"),
      (error: any) => error.code === "advocates_locked_by_verdicts");
  });

  test("happy path: four arguments and three decisions", async () => {
    const { view, calls } = await runCase({});
    assert.equal(view.status, "completed");
    assert.equal(view.advocates.filter((a: any) => a.argument).length, 4);
    assert.equal(view.judges.filter((j: any) => j.verdict).length, 3);
    assert.equal(calls.length, 7, "exactly seven model calls");
  });

  test("P0-5: failure while opening an attempt does not strand the case", async () => {
    const { id, session } = await startCase({});
    await worker.tick();
    const midway = await repo.getCaseProjection(id, session);
    assert.equal(midway!.stage, "advocates_complete", "the case waits for judges after the advocate stage");

    const judge = await db.pool.query(
      "SELECT id FROM runs WHERE case_id=$1 AND role='judge' AND instance_no=1", [id]);
    await db.pool.query(
      "INSERT INTO run_attempts(run_id,attempt_no,attempt_kind,outcome) VALUES($1,1,'initial','provider_error')",
      [judge.rows[0].id]);

    const view = await drive(id, session);
    assert.ok(TERMINAL.includes(view!.status), `case is stranded in status ${view!.status}`);
    const broken = view!.judges.find((j: any) => j.slot === "judge_1")!;
    assert.ok(broken.error, "a failed run must carry an error");
    assert.equal(broken.verdict, null);
  });

  test("P0-6: a case with no job and an expired deadline is closed", async () => {
    const { id, session } = await startCase({});
    await db.pool.query("DELETE FROM jobs WHERE case_id=$1", [id]);
    await db.pool.query("UPDATE cases SET deadline_at=now()-interval '1 minute' WHERE id=$1", [id]);
    const view = await drive(id, session, 6);
    assert.equal(view!.status, "failed");
    assert.equal(view!.termination_reason, "deadline_exceeded");
    const blank = [...view!.advocates, ...view!.judges]
      .filter((r: any) => !r.argument && !r.verdict && !r.error);
    assert.equal(blank.length, 0);
  });

  test("P0-5: a job with exhausted attempts is not claimed by a worker", async () => {
    const { id } = await startCase({});
    await db.pool.query("UPDATE jobs SET attempts=99 WHERE case_id=$1", [id]);
    const job = await repo.claimJob(randomUUID());
    assert.ok(job === null || job.case_id !== id, "an exhausted job must not be claimed");
  });

  test("P1-3: prompt drift between case creation and execution is rejected", async () => {
    const { id, session } = await startCase({});
    await db.pool.query(
      "UPDATE runs SET prompt_hash=decode(repeat('00',32),'hex') WHERE case_id=$1 AND role='advocate' AND instance_no=1",
      [id]);
    const view = await drive(id, session);
    const drifted = view!.advocates.find((a: any) => a.slot === "advocate_1")!;
    assert.equal(drifted.argument, null, "a run with a different prompt must not produce an argument");
    assert.equal(drifted.error?.code, "prompt_drift");
  });

  test("panel selection: a case is evaluated by the selected panel", async () => {
    const scenario = scenarioProvider({});
    providers.setProvider(scenario.provider as never);
    const session = await repo.ensureSession(randomUUID());
    const created = await repo.createCase(session, randomUUID(), INDICTMENT, "analytical");
    const view = await drive(created.id, session);
    assert.equal(view!.panel, "analytical");
    const expected = ["Strongest argument from each side", "Unsupported assumptions", "Gaps in the case"];
    assert.deepEqual(view!.judges.map((j: any) => j.lens_label).sort(), [...expected].sort());
  });

  test("panel selection: the same key with another panel conflicts instead of returning silently", async () => {
    const session = await repo.ensureSession(randomUUID());
    const key = randomUUID();
    const first = await repo.createCase(session, key, INDICTMENT, "ethical");
    const same = await repo.createCase(session, key, INDICTMENT, "ethical");
    assert.equal(same.id, first.id, "the same key and panel must return the same case");
    await assert.rejects(
      () => repo.createCase(session, key, INDICTMENT, "analytical"),
      (error: any) => error.code === "idempotency_key_conflict");
  });

  test("lens labels reach the UI projection", async () => {
    const { view } = await runCase({});
    for (const judge of view.judges) {
      assert.ok(judge.lens_label, `${judge.slot}: missing lens label`);
    }
    assert.equal(new Set(view.judges.map((j: any) => j.lens_label)).size, 3,
      "the three judges must carry three distinct labels");
    for (const advocate of view.advocates) assert.ok(advocate.lens_label, `${advocate.slot}: missing ground label`);
  });

  test("priority 5: a paid but invalid attempt counts toward case spend", async () => {
    const { id, session } = await startCase({ "advocate:1": { body: JSON.stringify({ position: "justified" }) } });
    await drive(id, session);
    const spent = await db.pool.query("SELECT spent_usd FROM cases WHERE id=$1", [id]);
    assert.ok(Number(spent.rows[0].spent_usd) > 0, "case spend must not remain zero");
    const violated = await db.pool.query(
      `SELECT a.cost_usd FROM run_attempts a JOIN runs r ON r.id=a.run_id
       WHERE r.case_id=$1 AND r.role='advocate' AND r.instance_no=1 AND a.outcome='contract_violation'`, [id]);
    assert.ok(violated.rows.length > 0, "a contract violation must be recorded as an attempt");
    assert.ok(Number(violated.rows[0].cost_usd) > 0, "the paid invalid attempt cost was lost");
  });

  test("priority 5: judge stage does not start when the budget cannot cover the worst case", async () => {
    const { id, session, calls } = await startCase({});
    await worker.tick();
    await db.pool.query("UPDATE cases SET budget_usd=0.02 WHERE id=$1", [id]);
    const view = await drive(id, session);
    assert.equal(view!.termination_reason, "budget_exhausted");
    assert.equal(calls.filter(c => c.startsWith("judge")).length, 0, "no judge may start");
    assert.equal(view!.judges.filter((j: any) => j.verdict).length, 0);
  });
}
