# Tribunal model-role layer

This document explains how Tribunal implements the fixed four-advocate, three-judge protocol. These are runtime model roles, not coding subagents.

## 1. Protocol

Every case contains exactly seven slots created in the same transaction as the case:

| Slot | Role | Assigned stance |
| --- | --- | --- |
| 1–2 | Advocate | `justified` |
| 3–4 | Advocate | `not_justified` |
| 5–7 | Judge | none |

Advocates run first. Judges run only when all four advocates have succeeded. Each judge receives the indictment and all four arguments, but never another judge's output. Judge decisions remain separate in storage, API responses, and the UI.

`activeRoles()` in `src/prompts-registry.ts` is the canonical deterministic slot builder. Database constraints independently enforce role, instance, and stance combinations.

## 2. Prompt composition

Prompts are assembled from versioned files rather than stored as seven duplicated documents.

```text
prompts/
  shared/guardrails.md
  advocate/core.md
  advocate/stance/justified.md
  advocate/stance/not_justified.md
  advocate/ground/ex_ante.md
  advocate/ground/ex_post.md
  advocate/ground/flat.md
  judge/core.md
  judge/lens/ethical/*.md
  judge/lens/evidentiary/*.md
  judge/lens/analytical/*.md
  judge/lens/control/uniform.md
  versions.json
  prompts.lock.json
```

An advocate prompt contains shared guardrails, the advocate contract, its assigned stance, and one reasoning ground. A judge prompt contains shared guardrails, the judge contract, and exactly one judge lens.

The fixed block order gives prompts a stable shared prefix and makes every behavioral component auditable.

## 3. Advocate differentiation

The default `grounds` scheme gives two complementary grounds to each stance:

- `ex_ante` evaluates information, duties, and foreseeable risks available when the act was chosen;
- `ex_post` evaluates actual consequences and proportionality without treating hindsight as knowledge available earlier.

The pattern is symmetric: slots 1 and 3 use `ex_ante`; slots 2 and 4 use `ex_post`. The `control` scheme assigns `flat` to all advocates and exists only as an evaluation baseline.

## 4. Judge panels

Three differentiated panels are selectable:

| Panel | Judge 1 | Judge 2 | Judge 3 |
| --- | --- | --- | --- |
| `ethical` | duties and rules | consequences and costs | intent and character |
| `evidentiary` | high burden of proof | balance of established facts | benefit of the doubt |
| `analytical` | strongest argument from each side | unsupported assumptions | gaps in the case |

The `control` panel gives all three judges the same `uniform` prompt. It is intentionally excluded from the user-facing panel API because it is a measurement baseline, not a product experience.

The selected panel changes how the three judges reason, never their count or independence. The panel is part of case idempotency so the same key cannot silently return a case created under different lenses.

## 5. User-facing labels

Panel titles, summaries, and lens labels are defined once in `src/prompts-registry.ts` and returned through `GET /api/v1/panels`. The client displays them beside each argument and decision. A disagreement without lens context is ambiguous; labels are therefore part of the case projection.

## 6. Prompt versioning and lock

`prompts/versions.json` assigns a semantic version to every prompt block. A composed prompt version is the ordered `+`-joined list of its block versions. A shared-block edit therefore changes the identity of every affected role prompt.

`prompts/prompts.lock.json` records the composed version and SHA-256 hash for every prompt name. Startup verification fails if composed content differs from the lock. The lock rebuild command refuses to accept content changes without a corresponding block version bump.

Workflow for a prompt edit:

1. change the prompt block;
2. bump that block in `prompts/versions.json`;
3. run `npm run build:server`;
4. run `npm run prompts:lock`;
5. inspect the lock diff;
6. run `npm run check`.

Never edit a prompt without a version bump and verification.

## 7. Response contracts

Advocates must return exactly:

```json
{ "position": "justified", "reasoning": "..." }
```

Judges must return exactly:

```json
{ "decision": "justified", "reasoning": "..." }
```

Allowed decision values are `justified` and `not_justified`. Additional keys are rejected. Advocates must match their assigned stance. A failure or invalid response remains an error and never receives a default decision.

## 8. Validation layers

`validateModelOutput()` applies distinct checks in order:

| Layer | Check | Example code |
| --- | --- | --- |
| L0 | transport and finish reason | `empty_response`, `truncated_response` |
| L7 | prompt-leak canary in raw output | `prompt_leak` |
| L1 | JSON extraction | `unparseable_output` |
| L6 | opposite role contract | `role_confusion` |
| L2 | required keys, types, no extras | `schema_violation` |
| L3 | allowed enum values | `enum_violation` |
| L4 | reasoning length | `length_violation` |
| L5 | assigned role or stance | `role_violation` |

Layer-specific codes make prompt and model quality measurable. Prompt leaks and API-key failures are non-retryable. Other bounded failures may be retried according to the worker policy.

## 9. Structured output and model calls

JSON Schema is derived from the same Zod contracts used for runtime validation. OpenRouter receives strict `json_schema` by default. If a model explicitly rejects that format, the adapter performs one compatible `json_object` retry; unrelated 4xx responses are not converted into format fallbacks.

Default role settings are configured in `.env.example`:

- advocate and judge model identifiers;
- temperature and maximum output tokens;
- per-call timeouts;
- maximum attempts;
- global outbound concurrency;
- cost fallback rates and budgets.

The provider reports tokens, cost, latency, model, finish reason, and raw output. Paid but invalid responses still count toward spend.

## 10. Verification

Automated coverage checks:

- exact 4+3 slot balance and fixed stances;
- 4/4 advocate barrier before judges;
- judge independence and absence of verdict-combination vocabulary;
- panel and advocate-ground differentiation;
- prompt composition, hashes, versions, and lock integrity;
- strict and compatible structured-output modes;
- validation-layer diagnoses and retryability;
- explicit partial and full failure behavior;
- prompt drift between case creation and execution;
- cost accounting and budget gates.

Run all available gates with `npm run check`. PostgreSQL integration tests run only when a database is reachable.

## 11. What remains to evaluate

Code proves structural differentiation, but it does not prove that a particular live model produces consistently distinct, high-quality reasoning. Before enabling live inference for real users, run a fixed evaluation corpus across all selectable panels and advocate grounds. Measure contract pass rate, stance adherence, decision diversity, semantic similarity, latency, token usage, cost, and failure rate.

Live OpenRouter evaluation requires explicit authorization and a spending limit. The default scripted adapter is appropriate for development and demonstrations but cannot establish model quality.

## 12. Product decisions still requiring an owner

- which OpenRouter models to assign to advocates and judges;
- acceptable quality, latency, and cost thresholds;
- whether the default panel should remain `ethical`;
- authentication and retention policy for public deployment;
- whether additional panels belong in the product or only in evaluation.

None of these decisions may alter the mandatory 4+3 protocol or introduce a combined verdict.
