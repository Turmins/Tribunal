import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://tribunal:tribunal@localhost:5432/postgres";

export async function databaseReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

/** Create a temporary database and apply the migration's Up section. Production data is untouched. */
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `tribunal_it_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const sql = await readFile("migrations/001_initial.sql", "utf8");
  const up = sql.split("-- Down Migration")[0] ?? "";
  const target = new pg.Client({ connectionString: url });
  await target.connect();
  await target.query(up);
  await target.end();

  return {
    url,
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Scripted provider: each "role:instance" key maps to a response or failure. */
export function scenarioProvider(script: Record<string, { body?: string; fail?: string; finishReason?: string }>) {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async complete(request: { role: string; instance: number; stance: string | null }) {
        const key = `${request.role}:${request.instance}`;
        calls.push(key);
        const step = script[key] ?? {};
        if (step.fail) throw new Error(step.fail);
        const body = step.body ?? JSON.stringify(
          request.role === "advocate"
            ? { position: request.stance, reasoning: "x".repeat(400) }
            : { decision: "justified", reasoning: "x".repeat(400) });
        return {
          rawBody: body, finishReason: step.finishReason ?? "stop", provider: "test", model: "test-v1",
          inputTokens: 100, outputTokens: 80, costUsd: 0.001, latencyMs: 1,
        };
      },
    },
  };
}

export const INDICTMENT = {
  defendant: "Test defendant",
  act: "Made a test decision with consequences for the team",
  question: "Was this decision justified?",
};
