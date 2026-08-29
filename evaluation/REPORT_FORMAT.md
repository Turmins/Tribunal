# Evaluation report format

Format identifier: `tribunal-evaluation/1.0.0` (the `report_format` field).

Every run writes two files with the same content: a machine-readable `.json` and
a human-readable `.md`. Both are deterministic for a given set of run outcomes —
object keys are emitted in sorted order, rows are sorted by a stable key, and the
timestamp is supplied by the caller rather than read from the clock inside the
builder.

## What a report never contains

- model reasoning text, in whole or in part;
- raw provider responses;
- composed prompt bodies or indictment payloads;
- an API key, an `Authorization` header, or any other credential;
- a majority, consensus, winner, score, ranking, or merged verdict.

Reports carry derived measurements only: counts, rates, token totals, costs,
latencies, and failure codes. Reasoning length is recorded; reasoning is not.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `report_format` | Format identifier and version. |
| `generated_at` | ISO timestamp supplied by the caller. |
| `execution` | `dry-run`, `mocked-verification`, or `real-execution`. See below. |
| `mode` | `dry-run` or `execute`: what the harness was asked to do. |
| `structured_output_mode` | `json_schema` or `json_object`, from configuration. |
| `planned` | `calls` and `conservative_max_cost_usd` for the whole run. |
| `budget` | `approvedUsd`, `spentUsd`, `remainingUsd`, `overrun`. `null` for a dry run. |
| `stopped_reason` | `budget_exhausted` when the run halted before a call, otherwise `null`. |
| `fixtures_evaluated` | Sorted fixture ids. |
| `roles_evaluated` | Sorted roles. |
| `models` | Per-model results, sorted by model id. |
| `diversity_proxy_note` | Restates that the proxy is not evidence of quality. |
| `verdicts_combined` | Always `false`. The harness computes no merged result. |

### `execution` values

These are deliberately distinct, because a report that cannot tell them apart is
misleading:

- **`dry-run`** — nothing was sent. Only planned work and its conservative cost
  ceiling are described.
- **`mocked-verification`** — calls were served by a stub provider. Useful for
  verifying the format and the metrics; says nothing about any real model.
- **`real-execution`** — paid calls were made against OpenRouter.

## Per-model fields

| Field | Meaning |
| --- | --- |
| `model` | Requested model identifier. |
| `planned_calls`, `planned_max_cost_usd` | Work planned for this model. |
| `contract` | `attempted`, `valid`, `successRate`, and `failures` keyed by `layer:code`. |
| `stance_adherence_rate` | Advocates only: share whose position matched the assigned stance. |
| `decision_distribution` | Judge decision counts: `justified`, `not_justified`, `unavailable`. Descriptive only. |
| `input_tokens`, `output_tokens`, `latency_ms` | `count`, `min`, `max`, `mean`, `total`. |
| `cost_usd` | Settled cost for this model. |
| `finish_reasons` | Counts keyed by provider finish reason. |
| `format_fallback_count` | Calls where strict `json_schema` fell back to `json_object`. |
| `http_attempts_total` | HTTP requests issued, including format-fallback retries. |
| `fixtures` | Per-fixture breakdown, sorted by fixture id. |

## Per-fixture fields

| Field | Meaning |
| --- | --- |
| `fixture_id` | Stable fixture identifier. |
| `contract` | Same shape as the model-level contract block. |
| `decision_distribution` | Judge decisions for this fixture. |
| `judge_text_diversity_proxy` | Mean pairwise Jaccard distance between judge reasoning vocabularies, or `null` when fewer than two judges produced text. |
| `judge_texts_compared` | How many judge texts entered the proxy. |
| `calls` | One row per role slot, sorted by slot. |

## Per-call rows

Each row records `role`, `slot`, `instance`, `stance_assigned`,
`stance_adherence`, `decision`, `succeeded`, `contract_valid`, `contract_layer`,
`contract_code`, `prompt_name`, `prompt_version`, `prompt_hash`,
`reported_model`, `input_tokens`, `output_tokens`, `reasoning_length`,
`cost_usd`, `estimated_max_cost_usd`, `latency_ms`, `finish_reason`,
`http_attempts`, and `format_fallback`.

The prompt name, version, and SHA-256 hash make every measurement traceable to
the exact prompt that produced it, which is the same provenance the product
stores on a run.

## Interpreting the diversity proxy

`judge_text_diversity_proxy` is the mean pairwise Jaccard distance over judge
reasoning vocabulary: `1 - |shared words| / |all words|`, averaged across the
three judge pairs, using lowercase alphanumeric tokens of three characters or
more.

It measures **word overlap and nothing else**. It is not evidence that a panel's
lenses produced genuinely different reasoning:

- two judges can reach materially different conclusions in similar vocabulary and
  score low;
- boilerplate rephrasing of one idea can score high;
- it cannot detect whether a lens changed the substance of an argument.

Use it to decide which outputs deserve a human read. Do not use it as a quality
score, and do not compare models on it alone.

## Example

`evaluation/example/` contains a synthetic report produced by a deterministic
stub provider with a fixed timestamp. It is labelled `mocked-verification` and
describes no real model. Regenerate it with:

```sh
npm run eval:example
```

## Where real results go

Actual run output is written to `evaluation/results/`, which is git-ignored
because it can contain provider metadata and per-run measurements. Only
fixtures, this format document, and the synthetic example are tracked.
