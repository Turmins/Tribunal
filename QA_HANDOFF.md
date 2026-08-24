# Tribunal QA handoff

## 1. Objective

Verify the complete request cycle and the product's central safety claim: a failed or missing model response never becomes a substantive verdict, and the three judge decisions are never combined into an automated conclusion.

## 2. Sources of truth

Read in this order:

1. `TRIBUNAL_CONTEXT_HANDOFF.md` — mandatory course requirements;
2. `ARCHITECTURE.md` — current target and implementation design;
3. `AGENTS.md` — prompt composition, panels, and response validation;
4. `QA_REPORT.md` — current evidence and residual risk;
5. `README.md` — setup and route summary.

## 3. Invariants

- A case contains exactly four advocates and three judges.
- Advocates 1–2 are assigned `justified`; advocates 3–4 are assigned `not_justified`.
- No judge runs before all four advocate arguments pass validation.
- Every judge receives the indictment and four arguments, but no other judge result.
- The product stores and renders three independent decisions with no vote, winner, score, or merged result.
- A failed judge has `verdict: null` and an explicit error.
- A terminal case has no role slot that appears indefinitely pending.
- The user remains the final decision-maker.

## 4. Safe local setup

Use the scripted provider unless live-model evaluation is explicitly authorized.

```sh
docker compose up -d db
copy .env.example .env
npm ci
npm run migrate
npm run check
```

Do not add a real OpenRouter key to project files. Do not delete the Docker volume or reset an existing database during routine QA.

## 5. Baseline coverage

The repository contains unit and contract coverage for protocol balance, prompt boundaries, panels, prompt locking, structured output, validation layers, safe errors, status labels, pricing, provider fallback, and configuration consumption.

When PostgreSQL is reachable, integration coverage additionally exercises:

- creation of exactly seven runs;
- the 4/4 advocate barrier;
- happy-path four arguments and three decisions;
- one-judge and all-judge failures;
- terminal slots with explicit outcomes;
- retry rules and prompt drift;
- job recovery and exhausted claims;
- selected-panel persistence and labels;
- idempotency across panel choices;
- paid invalid attempts and judge-stage budget gating.

## 6. Priority checklist

### Protocol and data

- [ ] A valid case creates exactly seven `runs` rows.
- [ ] Role, instance, and stance combinations match the fixed protocol.
- [ ] Judges are not called when any advocate fails.
- [ ] Every judge input includes exactly four ordered advocate arguments.
- [ ] Judge input contains no output from another judge.
- [ ] API projections always contain four advocate and three judge slots.
- [ ] There is no stored or returned combined-verdict field.

### API

- [ ] Invalid indictment fields return 400 before case creation.
- [ ] Malformed JSON, oversized bodies, and invalid UUIDs retain distinct safe codes.
- [ ] Repeating the same key and input returns the same case.
- [ ] Reusing the same key for another indictment or panel returns a conflict.
- [ ] Session A cannot list, read, retry, or delete session B's cases.
- [ ] Health and readiness differ appropriately when the database or prompt lock is unavailable.

### Failure behavior

- [ ] One advocate failure prevents every judge call.
- [ ] One judge failure produces two visible decisions and one error card.
- [ ] Three judge failures produce `failed`, not `partial`.
- [ ] Timeout, truncated output, malformed JSON, schema violation, wrong role, wrong stance, and prompt leak remain failures.
- [ ] A terminal case contains no result-less, error-less run.
- [ ] Retrying does not recompute successful roles.
- [ ] Advocate retry is blocked after any successful judge decision.

### Prompts and security

- [ ] All role prompts match `prompts.lock.json`.
- [ ] Prompt edits without version bumps fail the lock workflow.
- [ ] Reserved wrapper delimiters are removed from indictments and advocate arguments.
- [ ] Every composed prompt includes shared guardrails and the canary.
- [ ] The OpenRouter key is absent from browser assets, logs, fixtures, and Git.
- [ ] User-facing errors contain no raw provider or database details.

### Economics and operations

- [ ] Every attempt records tokens, latency, model, cost, and outcome.
- [ ] Paid invalid output counts toward case spend.
- [ ] The judge stage starts only when all three judges fit the remaining budget.
- [ ] The global daily gate rejects new cases after its threshold.
- [ ] Concurrent outbound calls do not exceed configuration.
- [ ] Expired leases and deadlines recover to honest terminal states.

### UI

- [ ] Empty, invalid, submitting, advocate, judge, complete, partial, and failed states are distinguishable.
- [ ] Three judge cards have equal hierarchy and display their lens labels.
- [ ] No visual element implies majority, winner, or recommended verdict.
- [ ] A failed role never displays decision vocabulary.
- [ ] Previous cases are limited to the current browser session.
- [ ] The external-provider personal-data warning is visible before submission.

## 7. Manual browser route

With scripted mode and a reachable database:

1. Open the Vite UI.
2. Submit an incomplete indictment and confirm local/browser validation.
3. Submit a valid case and observe advocate progress followed by judge progress.
4. Confirm four advocate entries and three judge cards.
5. Confirm all judge cards show distinct lens labels for a differentiated panel.
6. Open previous cases and reopen the created case.
7. Inspect the network response and confirm there is no combined result field.
8. Build production assets and repeat the path through Fastify on one origin.

## 8. Reporting format

For each defect record:

- severity and user impact;
- prerequisites and exact reproduction steps;
- expected and actual behavior;
- violated requirement or invariant;
- evidence and smallest useful regression test;
- changed files and verification outcome if fixed.

End with separate readiness decisions for local scripted demonstration, live OpenRouter use, and public deployment. Explicitly state whether the 4+3 protocol and absence of verdict combination were verified.

## 9. Current risk focus

The deterministic protocol is extensively covered. The main unproven area is live-model quality: differentiated prompts do not by themselves prove useful, stable, or sufficiently distinct outputs from the chosen models. Live evaluation must use a fixed corpus, explicit success metrics, and a spending limit.
