# Tribunal

Tribunal is a web application for examining a difficult act from opposing perspectives. Four independent AI advocates prepare two arguments that the act was justified and two that it was not. Only after all four valid arguments exist do three independent AI judges produce three reasoned decisions.

The application never chooses a winner, counts votes, or creates a combined verdict. The human user interprets the disagreement and makes the final decision.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the implementation design, [TRIBUNAL_CONTEXT_HANDOFF.md](./TRIBUNAL_CONTEXT_HANDOFF.md) for the course requirements, [AGENTS.md](./AGENTS.md) for the model-role layer, [LIVE_EVALUATION.md](./LIVE_EVALUATION.md) for the guarded live-evaluation tools, and [QA_REPORT.md](./QA_REPORT.md) for current verification evidence.

## Implemented

- strict TypeScript 5, Node.js 22, and Fastify 5;
- React 19, Vite, and TanStack Query polling;
- PostgreSQL 16 with an integrity-constrained SQL migration;
- asynchronous stage jobs, leases, recovery, and stuck-case sweeping in PostgreSQL;
- atomic creation of one case and exactly seven role slots;
- a mandatory 4/4 advocate barrier before the judge stage;
- parallel role execution within each stage;
- a free deterministic `ScriptedProvider` for local development;
- a server-only OpenRouter adapter with timeouts and bounded retries;
- provider-reported or table-estimated costs, per-case and daily budget gates, and outbound concurrency limits;
- strict indictment and structured-output validation;
- prompt-boundary stripping, shared guardrails, and a prompt-leak canary;
- separate raw and normalized model-response storage;
- audit data for attempts, tokens, cost, latency, model, prompt, and version;
- anonymous browser sessions in an `HttpOnly` cookie with session-scoped history;
- idempotent case creation, targeted stage retry, and soft deletion;
- honest complete, partial, and failed states;
- three equal judge cards with no automated conclusion;
- composable, versioned prompt blocks protected by `prompts.lock.json`;
- three selectable differentiated judge panels plus a non-product control baseline;
- eight distinct model-response validation layers;
- strict `json_schema` output with one automatic `json_object` compatibility fallback;
- a budget-guarded OpenRouter canary and a deterministic model evaluation harness, both dry-run by default.

## Local setup

Requirements: Node.js 22 and Docker with Compose.

```sh
docker compose up -d db
copy .env.example .env
npm ci
npm run migrate
npm run dev
```

The API runs at `http://localhost:3000` and the Vite development UI at `http://localhost:5173`. A production build is served by Fastify from one origin:

```sh
npm run build
npm start
```

The default `MODEL_ADAPTER=scripted` mode requires no OpenRouter account and incurs no model cost. For live inference, set `MODEL_ADAPTER=openrouter` and provide `OPENROUTER_API_KEY` only in the server environment.

## Verification

```sh
npm run check
```

The command runs strict type checks, protocol and regression tests, and a production build. PostgreSQL integration scenarios run when a database is reachable and are reported as skipped otherwise. No test invokes live OpenRouter.

## Guarded live evaluation

Two commands prepare for paid inference without spending anything by default:

```sh
npm run live:canary     # plan one controlled logical completion; sends nothing
npm run eval:models -- --models <model-id>   # plan a model comparison; sends nothing
```

Both are dry-run unless `--execute` is supplied together with `--max-cost-usd`,
and both refuse to run when the conservative cost estimate does not fit the
approved limit. The API key is read from the server environment only and never
accepted as an argument. Automated verification performs no live OpenRouter call,
and the repository contains no live evaluation evidence. See
[LIVE_EVALUATION.md](./LIVE_EVALUATION.md).

## API

- `GET /api/v1/panels` — list selectable judge panels and their lenses;
- `POST /api/v1/cases` — create a case; requires `Idempotency-Key`;
- `GET /api/v1/cases/:id` — retrieve stage, seven slots, and results;
- `GET /api/v1/cases` — list cases from the current anonymous session;
- `POST /api/v1/cases/:id/retry` — retry failed advocates or judges;
- `DELETE /api/v1/cases/:id` — soft-delete a case owned by the current session;
- `GET /api/v1/health` and `GET /api/v1/ready` — liveness and readiness.

## First-version policies

- any failed advocate stops the case before judges until an explicit retry;
- a failed judge leaves successful independent decisions visible beside an explicit error card;
- retries do not recompute successful roles;
- the default case budget is `$0.25`;
- raw responses have a 30-day purge deadline recorded in the schema;
- public deployment without full authentication is acceptable only with anonymous-session isolation and a personal-data warning.

## Current readiness

The full 4+3 orchestration exists and is usable in scripted mode. Live model agents are not active by default: the repository uses `MODEL_ADAPTER=scripted`, and no OpenRouter key is committed. The canary and evaluation harness are implemented, but no tracked evidence establishes a successful live-provider run, so live model quality remains unmeasured. Public deployment still requires an explicit privacy, authentication, operations, and live-model evaluation decision.

For database inspection in the default local Compose setup, use host `localhost`, port `5432`, and database/user/password `tribunal`.
