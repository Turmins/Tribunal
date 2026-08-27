# Tribunal QA report

Report date: 27 August 2026
Scope: repository baseline, deterministic scripted mode, verified PostgreSQL integration, local end-to-end run, and English localization.

The 27 August 2026 pass executed the PostgreSQL integration suite against a running PostgreSQL 16 instance rather than skipping it, and drove the full 4+3 cycle through the production build. No paid model call was made at any point.

## 1. Readiness summary

| Target | Status | Rationale |
| --- | --- | --- |
| Local scripted demonstration | Ready; verified end to end on 27 August 2026 | `npm run check` passes with PostgreSQL reachable (84 passed, 0 failed, 0 skipped), and a complete 4+3 case was created, persisted, and rendered through the production build. |
| Live OpenRouter use | Not yet approved | The adapter exists, but model selection and fixed-corpus quality/cost evaluation remain unproven. |
| Public deployment | Not ready | Authentication, privacy, retention, abuse controls, operations, and deployment-level E2E evidence require owner decisions. |

The implementation is substantially beyond a UI skeleton. It contains the complete seven-role orchestration and failure model. The real model agents are deliberately inactive by default because `.env.example` selects `MODEL_ADAPTER=scripted` and no OpenRouter key is committed.

## 2. Mandatory invariant evidence

| Invariant | Implementation evidence | Automated evidence |
| --- | --- | --- |
| Exactly four advocates and three judges | `activeRoles()` plus database role/instance checks | protocol and registry tests |
| Fixed advocate stances | slot registry plus database stance checks | protocol and registry tests |
| 4/4 barrier before judges | worker stage gate and atomic repository transition | integration failure scenario |
| Judges receive four arguments | deterministic evidence builder | boundary and integration tests |
| Judges receive no peer decisions | input builder accepts only indictment and advocate arguments | protocol/source test |
| No combined verdict | no schema, API, storage, or UI field for aggregation | forbidden-vocabulary test |
| Failure is not a verdict | separate normalized result/error fields and safe messages | validation, status, error, and integration tests |
| Human makes final decision | three equal cards and explicit UI copy | manual/UI review plus source contract |

## 3. Implemented reliability controls

- case, seven slots, and first job are created atomically;
- stage jobs use leases, heartbeat, claim limits, and `SKIP LOCKED`;
- stage completion and transition occur in one repository transaction;
- expired or jobless cases are swept to honest terminal states;
- unreached terminal slots become explicit `aborted` failures;
- prompt content is versioned, hashed, locked, and verified on startup;
- prompt drift after case creation rejects the affected run;
- strict model output derives from runtime contracts;
- provider format incompatibility receives one narrow compatibility fallback;
- provider, timeout, contract, role, and prompt-leak failures remain distinct;
- paid invalid attempts are included in spend;
- case and daily budgets plus global concurrency bound economic exposure.

## 4. Historical high-severity findings and resolution

The first QA pass found several structural defects. They are retained here as regression history, not current open findings.

| Finding | Resolution | Regression evidence |
| --- | --- | --- |
| Zero successful judges could be labeled `partial` | `judgeStageOutcome(0)` now returns `failed` | status and integration tests |
| New, failed, or partial cases could receive a misleading completion label | terminal status now takes precedence over stage and has distinct copy | UI-label tests |
| Terminal judge cards could remain indefinitely pending | unfinished terminal runs are aborted with explicit safe errors | integration test |
| Indictment or argument delimiters could escape the data wrapper | boundary stripping applies to user fields and advocate output | boundary tests |
| Exceptions outside the attempt loop could strand a case | worker-level failure containment closes the run and stage | integration test |
| Cases with missing/exhausted jobs could remain active forever | recovery sweep handles deadlines and missing/exhausted jobs | integration tests |
| Invalid paid output could disappear from cost accounting | failed attempts record usage and update case spend | pricing and integration tests |
| Domain errors could collapse into unrelated codes | `AppError` and `mapError()` preserve safe domain codes | error tests |
| Prompt content could change without an audit identity change | block versions plus the prompt lock enforce drift detection | registry and integration tests |

## 5. Current implementation gaps

### Model quality

Structural prompt differentiation is verified, but live quality and semantic diversity are not. A fixed-corpus evaluation must establish stance adherence, contract pass rate, meaningful judge differentiation, latency, token use, cost, and failure rate for the selected OpenRouter models.

### Public security and privacy

Anonymous session isolation is suitable for a local course demonstration, not a final public trust model. Public release needs explicit authentication, retention and deletion policy, consent language, rate limiting, secret rotation, abuse handling, and incident response.

### Operations and E2E coverage

The worker and schema provide recovery mechanisms, but production alerting and dashboards are not implemented. Browser-level end-to-end coverage should run against a deployed-like one-origin build with a real PostgreSQL instance.

## 6. Verification results

### 6.1 Environment

| Item | Value |
| --- | --- |
| Docker Engine | 29.7.2 (daemon started for this pass) |
| Docker Compose | v5.3.1 |
| PostgreSQL | `postgres:16-alpine`, service `db`, container `tribunal-db-1`, state `healthy` |
| Node.js | v22.18.0 |
| Model adapter | `scripted` (`OPENROUTER_API_KEY` present but empty; no live call made) |

The existing Docker volume and database were reused. No volume was removed, no database was reset, and no migration history was altered.

### 6.2 Migration

`npm run migrate` reported `No migrations to run!`: migration `001_initial` was already recorded in `pgmigrations`, applied 15 August 2026. The schema was verified directly and contains all nine expected tables. Existing data was left intact.

`node-pg-migrate` prints `Can't determine timestamp for 001` because the migration filename is not timestamp-prefixed. This is a naming-convention notice, not a failure, and the migration ledger is correct.

### 6.3 Gates

| Gate | Scope | Result on 27 August 2026 |
| --- | --- | --- |
| `npm test` | unit, contract, and PostgreSQL integration tests | 84 passed, 0 failed, 0 skipped |
| PostgreSQL integration subset | `tests/worker.integration.test.ts` | 16 passed, 0 failed, 0 skipped |
| `npm run check` | strict TypeScript, full suite, Vite production build | passed |
| `npm run build` | server JavaScript plus 77-module client bundle | passed |
| Prompt lock verification | `GET /api/v1/ready` | `ready: true` (database and prompt lock verified) |
| Cyrillic scan | 75 tracked files, filenames, and commit metadata | zero matches |
| `git diff --check` | whitespace errors | passed |

Before the fix in section 7 the suite stood at 79 passed, 0 failed, 0 skipped; the five regression tests added with that fix bring the total to 84.

The integration suite skips only when PostgreSQL is unreachable, and it registers exactly one placeholder test when it does. Zero skips therefore confirms that all 16 database scenarios really executed. Integration tests create and drop a temporary `tribunal_it_<random>` database and never touch application data.

### 6.4 Local end-to-end run

The production build was served by Fastify on one origin and driven through the API and the browser UI.

Observed lifecycle for a valid case:

```text
queued/intake -> running/advocates -> running/advocates_complete -> running/judges -> completed/finished
```

The distinct `advocates_complete` stage between the two waves is direct evidence of the 4/4 barrier. Polling throughout the run never observed a judge run started while fewer than four advocates had succeeded.

61 API assertions and 12 retry/polling assertions passed, covering: exactly four advocate and three judge slots; fixed stances; four arguments and three decisions; verdict/error mutual exclusivity; no pending slot on a terminal case; session-scoped history; session isolation for read, list, and delete; idempotency reuse and conflict; refused retries on a completed case; ETag revalidation; owner soft delete; input validation; and safe error envelopes.

Persistence was confirmed directly in PostgreSQL: the case row, exactly seven `runs` (four advocates, three judges) with correct stances, four `advocate_arguments`, and three `judge_verdicts` holding independent decisions.

### 6.5 Absence of verdict combination

Verified at four independent levels:

- schema: no column in any table matches merge vocabulary (majority, consensus, winner, aggregate, combined, merged, final, overall, score, vote, tally, average, rank, recommend, prevail, summary, conclusion);
- database constraints: `runs_check` independently rejects a fifth advocate, a fourth judge, and a judge carrying a stance; probes were rolled back and the run count stayed at seven;
- API: no case-level verdict, decision, or result field exists, and no response key matches any merge term. Decisions live only inside the three-element `judges` array;
- UI: three equally sized cards rendered by one component, distinct lens labels, and the explicit statements that Tribunal does not choose a winner and that decisions are never merged.

The scripted run produced a genuine disagreement (justified, not justified, justified) that was stored and displayed unresolved.

### 6.6 UI state verification

All four case states were confirmed to render distinctly and honestly:

| State | Case label | Judge cards |
| --- | --- | --- |
| Loading | `Judges: 0 of 3 ready` | three `Awaiting decision` |
| Completed | `Review complete` | three decisions |
| Partial | `Partially complete: received 2 of 3 decisions` | two decisions plus one `Decision unavailable` |
| Failed | `Review failed` | three `Decision unavailable`, no decision vocabulary present |

The scripted provider always succeeds, so partial and failed case states cannot arise from a live scripted run. Server-side partial and failed transitions are covered by the PostgreSQL integration tests, which assert them against the same `getCaseProjection` payload the API returns. The rendering of those two states was confirmed separately by supplying the corresponding projections to the client.

## 7. Findings from the 27 August 2026 pass

### Fixed: the previous-cases list reported an unconfirmed history as empty

- Severity: medium. It states a falsehood about the user's own data.
- Prerequisites: any browser session; the previous-cases view opened while the request to `GET /api/v1/cases` is unresolved or failing.
- Reproduction: open the previous-cases view and observe the message before the request settles, or with the request failing.
- Expected: an unresolved request reports loading and a failed request reports the failure.
- Actual: both rendered `There are no cases in this browser session yet.`
- Violated requirement: the interface must show pending and failed states honestly, and a failure must look like a failure rather than an ordinary result. A confirmed-empty history and an unknown history were indistinguishable.
- Evidence: with the history request failing, the message was sampled once per second for twelve seconds. It read `Loading previous cases…` at one second and the empty claim from two seconds onward. Inspecting the query state showed `status: pending`, `fetchStatus: paused`: a request waiting to retry is neither actively fetching nor finished, so an in-flight flag alone cannot distinguish unknown from empty.
- Fix: added `historyLabel()` to `client/src/labels.ts`, the module that already owns user-facing state labels and is already unit-tested. Emptiness is now claimed only for a confirmed successful response; every other state reports loading, and a known failure reports the failure in the existing error style. `History` in `client/src/main.tsx` uses it, matching the loading/error pattern `CaseView` already followed in the same file.
- Regression tests: five tests in `tests/ui-labels.test.ts`, including an exhaustive check that emptiness is claimed for exactly one flag combination.
- Verification: 84 passed, 0 failed, 0 skipped; strict TypeScript and the production build pass. All three states were then re-confirmed in the browser: loading stays `Loading previous cases…` for the full failure window and never claims emptiness, a failed query renders `Unable to load previous cases.` in the error colour, and a confirmed empty response renders the original message.
- Scope: presentation only. No protocol, API contract, failure policy, budget, or authorization behavior was changed.

### Observation: rebuilding while the server runs serves stale assets

Rebuilding the client while `npm start` is running caused the server to answer a request for a newly hashed asset with `index.html` and a `text/html` content type, because static serving resolves its file list at startup and the single-page fallback answers anything it cannot find. Restarting the server resolved it, and the documented order (`npm run build` then `npm start`) is unaffected. Not a defect in the shipped flow; noted because the fallback returns `200` with the wrong type for a missing asset rather than `404`. No change was made, since altering the fallback would change routing behavior.

### Observation: browser-native validation messages follow the browser locale

The indictment form relies on native `required` and `minLength` validation, so the browser supplies those messages in its own display language. This is browser chrome rather than project text and is not a localization defect. Authoritative validation remains server-side.

## 8. Test environment boundaries

- Default provider: scripted; model cost `$0.00`.
- Database integration tests create and drop a temporary database only.
- Existing application data and Docker volumes are not reset.
- If PostgreSQL is unavailable, the database-dependent suite registers an explicit skip and must be rerun before claiming database integration readiness in a new environment. On 27 August 2026 PostgreSQL was reachable and zero tests were skipped.
- The 27 August 2026 pass created five QA cases in the local `tribunal` database through the normal API, all through the scripted provider at `$0.00`. One was soft-deleted while verifying owner deletion. The four pre-existing cases were not modified or removed, and no temporary integration database remained afterwards.
- Prompt files themselves are already English and were not altered by localization; therefore prompt versions and hashes do not require a bump.

## 9. Localization audit

The English baseline covers:

- all visible client copy and HTML metadata;
- panel names, summaries, and lens labels returned by the API;
- server validation and safe failure messages;
- source comments and maintenance-script output;
- test names, fixtures, assertions, and diagnostics;
- README, architecture, agent-layer, QA, and handoff documentation.

The first Git commit must be created only after a repository-wide Cyrillic scan returns no matches, ensuring that no Russian baseline exists in project history.

## 10. Final QA decision rule

A merge-ready local baseline requires all deterministic checks and the production build to pass. A live-model release additionally requires approved spend and quality thresholds. A public release additionally requires resolved privacy, authentication, retention, abuse, and operations policies.

Under no readiness level may Tribunal alter the fixed four-advocate, three-independent-judge protocol or introduce a combined verdict.
