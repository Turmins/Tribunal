import { z } from "zod";

const env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgres://tribunal:tribunal@localhost:5432/tribunal"),
  MODEL_ADAPTER: z.enum(["scripted", "openrouter"]).default("scripted"),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  ADVOCATE_MODEL: z.string().default("openai/gpt-4o-mini"), JUDGE_MODEL: z.string().default("openai/gpt-4o"),
  ADVOCATE_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(0.15),
  ADVOCATE_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(0.60),
  JUDGE_INPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(2.50),
  JUDGE_OUTPUT_PRICE_PER_MILLION: z.coerce.number().nonnegative().default(10.00),
  GLOBAL_DAILY_BUDGET_USD: z.coerce.number().positive().default(5.00),
  MAX_INFLIGHT_MODEL_CALLS: z.coerce.number().int().min(1).max(64).default(4),
  STRUCTURED_OUTPUT: z.enum(["json_schema", "json_object"]).default("json_schema"),
  TEMPERATURE_ADVOCATE: z.coerce.number().min(0).max(2).default(0.8),
  TEMPERATURE_JUDGE: z.coerce.number().min(0).max(2).default(0.2),
  JUDGE_PANEL: z.enum(["ethical","evidentiary","analytical","control"]).default("ethical"),
  ADVOCATE_SCHEME: z.enum(["grounds","control"]).default("grounds"),
  MAX_CASE_COST_USD: z.coerce.number().positive().default(0.25),
  ADVOCATE_TIMEOUT_MS: z.coerce.number().int().positive().default(45000), JUDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(75000),
  CASE_DEADLINE_MS: z.coerce.number().int().positive().default(360000),
  MAX_ATTEMPTS_PER_RUN_AUTO: z.coerce.number().int().min(1).max(3).default(2),
  MAX_ATTEMPTS_PER_RUN_TOTAL: z.coerce.number().int().min(1).max(5).default(5),
  MAX_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
  SESSION_SECRET: z.string().min(16).default("local-development-secret-change-me"),
  ADMIN_TOKEN: z.string().default("")
}).parse(process.env);
export const config = env;
