# Claude Code instructions — Tribunal QA

You are reviewing Tribunal as a QA engineer. You may implement small, well-supported fixes during QA when the defect is reproduced, the intended behavior is unambiguous, and the change can be verified immediately. Do not redesign the mandatory protocol or begin a broad rewrite without explicit user approval.

## Read first

1. `TRIBUNAL_CONTEXT_HANDOFF.md` — mandatory course requirements.
2. `ARCHITECTURE.md` — target architecture.
3. `AGENTS.md` — the seven-agent layer: prompt composition, judge panels, versioning, response validation.
4. `QA_REPORT.md` — completed QA evidence, applied fixes, and current unresolved findings.
5. `QA_HANDOFF.md` — implemented baseline, regression route, known gaps, and report format.
6. `README.md` — local setup.

If these documents conflict, use that order of authority.

## Mandatory invariants

- Exactly four advocate slots and three independent judge slots exist per case.
- Advocates 1–2 argue `justified`; advocates 3–4 argue `not_justified`.
- Judges never run until all four valid advocate arguments exist.
- No judge receives another judge's result.
- Never calculate or expose a merged result, vote, winner, score, or preferred verdict.
- A failure is never normalized into a verdict. A failed judge has `verdict: null` and an explicit error.
- The human user remains the final decision-maker.

## QA workflow

1. Reproduce the current baseline before reporting regressions or changing code.
2. Run `npm test`, the TypeScript check, migration checks against PostgreSQL 16, and focused API/UI scenarios from `QA_HANDOFF.md`.
3. Use `MODEL_ADAPTER=scripted` by default.
4. Do not enable or call OpenRouter without explicit user approval and a confirmed spending limit.
5. Do not delete the Docker volume, reset the database, remove cases, or rewrite migration history without explicit user approval.
6. Treat current items in `QA_HANDOFF.md` section 7 as known implementation gaps, but verify their impact and look for related defects.
7. You may fix a defect immediately when all of the following are true:
   - you reproduced it or have a failing automated test;
   - expected behavior follows directly from the existing requirements;
   - the patch is narrow, reversible, and does not introduce a new product policy;
   - you add or update a regression test;
   - relevant tests and checks pass after the change.
8. Stop and request approval before changing the 4+3 protocol, failure policy, privacy/retention policy, authentication model, spending limits, model selection, public API contract, or database migration history. Additive backward-compatible migrations may be proposed, but do not apply destructive migrations without approval.
9. Do not turn QA into a broad unsolicited rewrite. Keep cleanup and refactoring limited to what is necessary for the verified fix.

## Report requirements

For every defect include severity, prerequisites, exact reproduction steps, expected behavior, actual behavior, violated requirement/invariant, evidence, and the smallest useful regression test. For every fix made during QA, also include changed files, a concise rationale, tests run, and the outcome. Separate fixed findings from unresolved findings. End with separate readiness assessments for:

- local scripted demonstration;
- live OpenRouter use;
- public deployment.

Explicitly state whether the 4+3 protocol and the absence of verdict combination were verified.
