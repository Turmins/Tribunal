# Tribunal QA report

Report date: 24 August 2026
Scope: repository baseline, deterministic scripted mode, PostgreSQL integration design, and English localization.

## 1. Readiness summary

| Target | Status | Rationale |
| --- | --- | --- |
| Local scripted demonstration | Ready after `npm run check` passes in the target clone | Full UI, API, persistence, 4+3 orchestration, and deterministic provider exist. |
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

| Gate | Scope | Result on 24 August 2026 |
| --- | --- | --- |
| TypeScript within `npm run check` | server, client, shared code, tests, and Vite config | passed |
| `npm test` | unit, contract, and conditional integration tests | 63 passed; one PostgreSQL wrapper skipped because the database was unavailable |
| Vite production build | 77 client modules and production assets | passed |
| `npm run build` | emitted server JavaScript plus production client assets | passed |
| Prompt lock verification | every composed prompt | exact version/hash match passed |
| Cyrillic scan | source, tests, prompts, configuration, and documentation | zero matches |
| `git diff --check` | whitespace errors | passed after documentation cleanup |

`npm run check` completed successfully outside the restricted workspace sandbox. The elevated execution was required only because Vite/esbuild could not traverse the OneDrive workspace under sandbox restrictions. No verification step made a paid OpenRouter call.

## 7. Test environment boundaries

- Default provider: scripted; model cost `$0.00`.
- Database integration tests create and drop a temporary database only.
- Existing application data and Docker volumes are not reset.
- If PostgreSQL is unavailable, the database-dependent suite registers an explicit skip and must be rerun before claiming database integration readiness in a new environment.
- Prompt files themselves are already English and were not altered by localization; therefore prompt versions and hashes do not require a bump.

## 8. Localization audit

The English baseline covers:

- all visible client copy and HTML metadata;
- panel names, summaries, and lens labels returned by the API;
- server validation and safe failure messages;
- source comments and maintenance-script output;
- test names, fixtures, assertions, and diagnostics;
- README, architecture, agent-layer, QA, and handoff documentation.

The first Git commit must be created only after a repository-wide Cyrillic scan returns no matches, ensuring that no Russian baseline exists in project history.

## 9. Final QA decision rule

A merge-ready local baseline requires all deterministic checks and the production build to pass. A live-model release additionally requires approved spend and quality thresholds. A public release additionally requires resolved privacy, authentication, retention, abuse, and operations policies.

Under no readiness level may Tribunal alter the fixed four-advocate, three-independent-judge protocol or introduce a combined verdict.
