# Tribunal architecture specification

Status: implemented local baseline. This document describes the current design and its mandatory invariants.

## 1. Executive summary

Tribunal uses an asynchronous two-stage workflow backed by PostgreSQL. `POST /api/v1/cases` stores the case, seven fixed role slots, and the first stage job in one transaction, then returns `202`. A worker claims leased jobs with `FOR UPDATE SKIP LOCKED`. Four advocates run in parallel; only a 4/4 success barrier can enqueue three parallel judges. Results remain independent and the client polls a projection of the case.

Five structural choices protect the product meaning:

1. Exactly seven role slots are created once and constrained by the database.
2. A verdict and an error are separate, mutually exclusive outcomes.
3. A missing advocate blocks all judges; a missing judge does not erase successful peers.
4. Judges cannot read other judge results because their input builder uses only the indictment and advocate arguments.
5. The API and source contain no majority, winner, consensus, or verdict-merging concept.

## 2. Goals and hard constraints

### 2.1 Goals

- Execute the fixed 4+3 course protocol without deviation.
- Never present a technical failure as a substantive decision.
- Preserve provenance for every model-visible result.
- Keep model cost, latency, retries, and concurrency bounded.
- Recover cases after process interruption without duplicating a stage.
- Keep the human user as the final decision-maker.

### 2.2 Mandatory protocol

| ID | Requirement |
| --- | --- |
| T-01 | Every case has four advocates and three judges. |
| T-02 | Advocates 1–2 argue `justified`; advocates 3–4 argue `not_justified`. |
| T-03 | Judges start only after all four valid advocate arguments exist. |
| T-04 | Every judge receives the indictment and all four advocate arguments. |
| T-05 | A judge never receives another judge's result. |
| T-06 | The system never aggregates, votes, ranks, or chooses among judge decisions. |
| T-07 | The UI shows three equal decisions and leaves the conclusion to the user. |
| T-08 | A failure is displayed as an error, never as a decision. |
| T-09 | Model prompts are project files with versions and hashes. |
| T-10 | Model calls and results are auditable for model, tokens, cost, latency, status, and time. |
| T-11 | Secrets remain server-side. |
| T-12 | User and model text is untrusted and validated. |
| T-13 | Advocate output is `{position, reasoning}`; judge output is `{decision, reasoning}`. |
| T-14 | Validation distinguishes transport, extraction, shape, enum, length, role, and prompt-leak failures. |
| T-15 | Calls, retries, tokens, concurrency, deadlines, and spend are bounded. |

### 2.3 Principles

- Deterministic code owns validation, orchestration, persistence, authorization, accounting, and rendering.
- Models own only advocacy and judgment.
- Stored state, not an HTTP request stack, is the source of truth.
- Partial success is explicit; synthetic success is forbidden.
- Database constraints enforce expensive invariants again even when application code already checks them.

## 3. Requirements and assumptions

The 4+3 protocol, independent judge outputs, OpenRouter gateway, structured charge sheet, persistence, cost accounting, and truthful failure UI come from the course requirements.

Current implementation policies that can change only through an explicit product decision:

- a failed advocate stops the workflow before judges;
- one or two failed judges produce a `partial` case with successful peers still visible;
- the default case budget is `$0.25`;
- anonymous browser sessions own case history;
- raw responses carry a 30-day purge deadline;
- the `ethical` panel is the default selectable panel;
- `control` is evaluation-only.

The architecture does not assume that three judges agree, use different model identifiers, or collectively produce a more correct answer.

## 4. Open product decisions

- live advocate and judge model selection;
- measured quality, latency, and cost thresholds;
- production authentication and privacy policy;
- deletion and audit retention rules;
- public rate limits and operations ownership;
- whether additional panels are product features or evaluation tools.

## 5. Architecture alternatives

A single synchronous request is simpler but cannot safely represent the worst-case duration of two model waves with retries. Process restarts would also lose in-memory progress.

The selected design uses PostgreSQL as both durable state and a small job queue. It is appropriate for this course-scale application because it adds no second operational system while preserving leases, retries, and restart recovery. A durable workflow engine would become attractive only at higher scale or with more complex branching.

## 6. Technology stack

- Node.js 22 and strict TypeScript;
- Fastify API and production static serving;
- React 19, Vite, and TanStack Query;
- PostgreSQL 16 and a SQL migration;
- Zod contracts and derived JSON Schema;
- OpenRouter adapter behind a provider interface;
- built-in Node test runner for unit and integration coverage.

## 7. Components and trust boundaries

```text
Browser
  -> Fastify API
      -> PostgreSQL repository and job queue
      -> stage worker
          -> prompt registry
          -> model provider
      -> case projection
  <- polling response
```

The browser is untrusted. It receives no API key, private protocol authority, or raw provider error. The API validates input, owns sessions, and returns a safe error envelope. The worker alone calls models. The repository owns state transitions and authorization-scoped projections.

## 8. Case lifecycle

1. The browser submits defendant, act, exact binary question, and optional panel with an `Idempotency-Key`.
2. The API validates and normalizes the indictment, strips reserved wrapper delimiters, verifies admission budget, and resolves the panel.
3. One transaction inserts the case, four advocate runs, three judge runs, and one advocate-stage job.
4. The worker leases the advocate job and runs the four pending advocates with bounded concurrency.
5. Each attempt records prompt identity, provider metadata, tokens, cost, latency, raw output, normalized output or explicit error.
6. The repository closes the advocate job and transitions the case atomically.
7. If fewer than four advocates succeed, unfinished roles are aborted and the case fails. No judge is called.
8. If the worst-case judge cost does not fit the remaining case budget, the case stops with `budget_exhausted`. No judge is called.
9. Otherwise one judge-stage job is enqueued idempotently.
10. The worker runs all three judges independently. Each receives the same indictment and ordered four-argument evidence wrapper plus its own prompt.
11. Three successes complete the case; one or two successes produce `partial`; zero successes produce `failed`.
12. The UI shows each role result or error without synthesizing a final result.

## 9. State machine

Cases use persisted `status`, `stage`, and `termination_reason` fields.

```text
queued -> running/advocates -> running/advocates_complete
  -> running/judges -> completed/finished
                    -> partial/finished
                    -> failed/finished

Any active state may become failed or cancelled through a bounded terminal path.
```

### 9.1 Terminal mapping

| Judge successes | Case status | Reason |
| ---: | --- | --- |
| 3 | `completed` | `null` |
| 1–2 | `partial` | judge failure code |
| 0 | `failed` | `judge_failure` |

Zero decisions is never described as partial. On a terminal case, every one of the seven runs has either a normalized result or an explicit error. Unreached slots are marked `aborted` with `stage_not_reached`.

## 10. Concurrency model

Jobs represent whole stages. `claimJob()` uses a row lock, a lease expiry, and a maximum claim-attempt count. A partial unique index prevents more than one pending or running job of the same kind per case.

Advocates run concurrently, then judges run concurrently. This reduces latency while preserving the causal barrier. `MAX_INFLIGHT_MODEL_CALLS` applies an instance-wide semaphore so bursts do not create unbounded provider spend or 429 responses.

The worker heartbeat extends long leases. Recovery sweeps cases whose deadline expired, whose job disappeared, or whose claims were exhausted.

## 11. API contracts

All failures use a safe envelope with a request identifier, stable code, user-facing message, and optional validation details. Domain codes reach the client unchanged; unknown internal exceptions become `internal_error`.

### 11.1 Case routes

- `GET /api/v1/panels` returns selectable panel titles, summaries, and three lens labels.
- `POST /api/v1/cases` returns `202` with `case_id` and queued status.
- `GET /api/v1/cases/:id` returns the indictment, lifecycle, four advocates, three judges, and totals.
- `GET /api/v1/cases` returns only cases owned by the current anonymous session.
- `POST /api/v1/cases/:id/retry` accepts `failed_advocates` or `failed_judges` after terminal failure.
- `DELETE /api/v1/cases/:id` soft-deletes a session-owned case.
- `GET /api/v1/health` reports process liveness.
- `GET /api/v1/ready` verifies database readiness and prompt-lock integrity.

Creation idempotency includes the normalized indictment and panel. Reusing a key for different input returns `idempotency_key_conflict`.

### 11.6 Indictment validation

The indictment is strict and contains only:

```json
{
  "defendant": "2..200 characters",
  "act": "10..2000 characters",
  "question": "5..300 characters"
}
```

Whitespace is normalized, zero-width characters and reserved prompt-wrapper delimiters are removed, unknown fields are rejected, and incomplete input cannot trigger a model call.

## 12. Data model

The migration defines:

- `sessions` — anonymous ownership;
- `cases` — indictment, panel, lifecycle, budgets, deadlines, deletion;
- `runs` — exactly seven role slots and prompt/model provenance;
- `run_attempts` — every paid or failed attempt;
- `advocate_arguments` — normalized advocate results;
- `judge_verdicts` — normalized judge results;
- `jobs` — leased stage work.

Important constraints:

- unique `(case_id, role, instance_no)`;
- allowed role/instance/stance combinations;
- advocate arguments reference advocate runs only;
- judge verdicts reference judge runs only;
- verdict and error state are mutually exclusive;
- one active job per case and kind;
- session-scoped case lookup and soft deletion.

The UI projection starts from `runs`, not result tables. Failed or unreached judges therefore remain visible as one of three explicit cards instead of disappearing from the response.

## 13. Model-response contracts and validation

### 13.1 Contracts

Advocate:

```json
{ "position": "justified | not_justified", "reasoning": "100..4000 characters" }
```

Judge:

```json
{ "decision": "justified | not_justified", "reasoning": "100..4000 characters" }
```

Contracts are strict and reject additional properties. JSON Schema is derived from the same Zod definitions used by validation and TypeScript inference.

### 13.2 Validation pipeline

Checks are intentionally diagnostic:

1. L0 transport and finish reason;
2. L7 prompt-leak canary in raw output;
3. L1 JSON extraction;
4. L6 opposite-role contract detection;
5. L2 required shape and types;
6. L3 enum values;
7. L4 reasoning length;
8. L5 assigned stance or role consistency.

Raw output and a successful normalized result are stored separately. Invalid paid responses still record tokens and cost but never create an argument or verdict.

## 14. Prompt system

Prompts are composable project files with shared guardrails, role cores, stances, grounds, and judge lenses. Every run stores prompt name, composed version, and SHA-256 hash.

`versions.json` versions each block. `prompts.lock.json` locks every composed role prompt. Startup fails on drift. Changing content requires a version bump and lock regeneration.

### 14.7 Prompt-prefix economics

Guardrails and the role contract appear before variable case data. This stable prefix improves audit readability and permits provider prompt caching where available. Caching is an optimization only; correctness never depends on it.

## 15. Failure and retry policy

- Provider timeouts, transient failures, malformed output, and bounded contract failures may retry up to the configured attempt limit.
- Successful runs are never recomputed during a failed-stage retry.
- Advocate retries are forbidden after any successful judge result because existing decisions refer to the original arguments.
- API-key failures and prompt leaks are non-retryable.
- The strict-schema adapter performs at most one format compatibility fallback.

### 15.2 Non-retryable failures

Prompt leaks, invalid API credentials, and explicit non-recoverable provider failures stop immediately. Retrying them would increase cost without changing the cause.

### 15.5 Recovery

The worker catches failures both inside and outside the attempt loop. Repository transitions close jobs and advance or terminate stages atomically. A periodic sweep terminates cases with expired deadlines, missing jobs, or exhausted job claims. Recovery never fabricates a result.

## 16. Product failure policies

### 16.1 Advocate barrier

Judges require four valid advocate arguments. A single failed advocate makes the advocate stage fail. The UI may show successful arguments and explicit failures, but all judge verdicts remain null.

### 16.2 Judge outcomes

Three judge successes complete the case, one or two produce partial success, and zero produce failure. Successful decisions remain visible beside explicit failed cards.

### 16.3 Budget gate

Before any judge begins, the remaining case budget must cover the worst-case output allowance of all three judges. The stage starts whole or not at all; launching only affordable judges would create an unauthorized selection rule.

### 16.5 Safe user messages

User-facing error messages come from `src/error-messages.ts`. They contain no decision values and never include raw provider, database, or stack details. This lexical separation helps prevent a failure from being read as a verdict.

## 17. Cost accounting

### 17.1 Attempt and case cost

Provider-reported `usage.cost` is authoritative when positive. Otherwise role-specific input/output rates estimate the cost. A live call is never treated as free merely because the provider omitted cost. Paid invalid attempts count toward the case budget.

### 17.2 Per-case controls

- bounded role count and attempts;
- maximum output tokens per role;
- per-call timeout and overall case deadline;
- default case budget;
- all-or-nothing judge-stage budget gate.

### 17.3 Global admission gate

New cases are rejected when instance-wide spend for the current day reaches `GLOBAL_DAILY_BUDGET_USD`. `MAX_INFLIGHT_MODEL_CALLS` separately limits the rate at which new cost can accumulate.

## 18. Security and privacy

- OpenRouter credentials remain in the server environment.
- Anonymous `HttpOnly`, `SameSite=Lax` cookies isolate case ownership.
- Every case route validates UUIDs before database access.
- User fields and model output are treated as untrusted.
- React escapes displayed content; no unsafe HTML rendering is used.
- Server logs and client errors avoid secrets and raw provider details.
- Public deployment requires explicit retention, privacy, authentication, and abuse-control decisions.

### 18.3 Prompt injection boundary

Indictments and advocate arguments are wrapped with reserved delimiters. Untrusted content is stripped of any attempt to reproduce those delimiters before prompt composition. Shared guardrails state that wrapped content is evidence, never instructions. The response canary detects likely system-prompt reproduction.

## 19. Observability

The natural trace hierarchy is `case -> stage -> run -> attempt`. Persisted fields support per-role latency, cost, tokens, failure code, model, prompt version, attempt count, and stage progress. Operational dashboards are not yet implemented, but the data model supports them.

## 20. Verification strategy

Automated gates cover:

- strict TypeScript compilation;
- exact 4+3 roles and stance assignment;
- source-level absence of verdict-combination vocabulary;
- prompt composition, version, hash, and lock integrity;
- input boundary stripping and prompt-injection defenses;
- structured-output format and fallback behavior;
- eight response-validation layers;
- safe error mapping and UI labels;
- panel differentiation and idempotency;
- failure, retry, recovery, accounting, and budget scenarios;
- production client and server builds.

PostgreSQL integration tests use a temporary database and never touch production data. They skip explicitly when PostgreSQL is unavailable. Live OpenRouter is excluded from the default suite.

## 21. Deployment model

The production build serves client assets and API from one Fastify origin. PostgreSQL must be reachable before readiness succeeds. The worker runs in the same Node process for the current scale. Horizontal deployment would require reviewing worker concurrency, lease timing, connection limits, and session-secret consistency.

Required production inputs include a managed PostgreSQL URL, strong session secret, explicit model adapter and budgets, and a deployment-specific privacy policy. Live mode additionally requires a server-only OpenRouter key and an approved evaluation result.

## 22. Decision record and remaining debt

Accepted decisions:

- asynchronous PostgreSQL-backed stage orchestration;
- fixed seven-slot protocol enforced in code and schema;
- hard 4/4 advocate gate;
- partial display for one or two successful judges;
- no verdict aggregation anywhere;
- provider interface with scripted and OpenRouter implementations;
- composable versioned prompts and startup lock verification;
- strict structured output with one compatibility fallback;
- provider-first cost accounting with a price-table fallback;
- anonymous session isolation for the local baseline.

Remaining work before public live use:

- run a fixed-corpus live-model quality and differentiation evaluation;
- define authentication, privacy, retention, abuse, and incident policies;
- add browser-level end-to-end coverage in a deployed-like environment;
- verify the final hosting platform's timeout, connection, and scaling behavior;
- establish production monitoring and alert thresholds.
