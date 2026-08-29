# Guarded live evaluation

Two command-line tools prepare Tribunal for paid inference without spending
anything by default:

- **the canary** — one controlled OpenRouter call, used to prove that a real
  provider call succeeds and satisfies the production contract;
- **the evaluation harness** — a deterministic comparison of models across a
  fixed corpus of fixtures.

**No live call has been made.** Both tools have only ever been exercised in
dry-run and with stubbed providers. Nothing in this repository establishes that
any OpenRouter model works, or how well.

## Safety model

Both tools follow the same rules.

| Rule | Behaviour |
| --- | --- |
| Default is dry-run | Without `--execute` nothing is sent and no key is needed. |
| Execution is opt-in twice | `--execute` **and** `--max-cost-usd` are both required. |
| Invalid limits are refused | Empty, zero, negative, or non-numeric limits are rejected before anything runs. |
| Estimates gate the call | A conservative maximum cost is computed first; if it does not fit the limit, no request is sent. |
| Prices are never guessed | A model absent from the shipped price table cannot be estimated, so it cannot run without explicit prices. |
| Keys come from the environment | `OPENROUTER_API_KEY` is read from `.env` or the server environment. A credential flag on the command line is refused outright. |
| Secrets never appear in output | No key, no `Authorization` header, no prompt body, and no raw response is printed or written. |
| Failures stay failures | An error, a truncated response, or a contract violation is recorded as a failure and never becomes a decision. |
| The protocol is untouched | These tools measure role slots in isolation. They create no case, write nothing to the database, and never combine judge decisions. |

Validation uses the production `validateModelOutput()` and the production
contracts. Requests are composed by the production prompt registry and boundary
wrappers, so the tools measure what the product would actually send.

## Cost estimation

The estimate exists to stop a call, so every unknown resolves in the expensive
direction:

- input tokens are approximated from text length and multiplied by a **1.25**
  margin, because character-based estimation under-counts dense text;
- output is charged at the **full role limit**, not an expected length;
- in `json_schema` mode the estimate is **doubled**, because a model that
  rejects strict schemas triggers one `json_object` retry. A format rejection is
  normally refused before generation and costs little, but the guard assumes the
  worst.

The shipped fallback price table describes only the two configured role models
(`ADVOCATE_MODEL` and `JUDGE_MODEL`). Any other model must be given prices
explicitly:

```sh
npm run live:canary -- --model vendor/some-model \
  --input-price-per-million 0.30 --output-price-per-million 1.20
```

Without them the tool refuses to run rather than estimating from an unrelated
model's prices, because an underestimate would silently defeat the limit. Take
the numbers from the provider's own pricing page; never from memory.

## The canary

### What it does

One advocate slot, on one fixture, with one model request. It deliberately does
**not** run the 4+3 protocol: judges require four valid advocate arguments, which
is the whole workflow and a much larger commitment.

### Dry run (safe, the default)

```sh
npm run live:canary
```

This prints the role and slot, the prompt name, version and hash, the model, the
structured-output mode, the maximum output tokens, the timeout, the temperature,
the conservative cost ceiling, and an explicit statement that no network call was
performed.

Useful variations, all still dry runs:

```sh
npm run live:canary -- --instance 3 --fixture ops-emergency-shutdown
npm run live:canary -- --model vendor/x --input-price-per-million 1 --output-price-per-million 2
```

### The one permitted real call

Do not run this without an explicit decision to spend money.

```sh
npm run live:canary -- --model openai/gpt-4o-mini --max-cost-usd 0.02 --execute
```

The result reports success or failure, provider and model, the contract outcome
with its failure layer and code, input and output tokens, cost, latency, finish
reason, how many HTTP attempts were made, and whether the `json_schema` to
`json_object` fallback was used. It prints no prompt, no raw response, and no
credential.

## The evaluation harness

### What it measures

For every selected model, every selected fixture, and every role slot: four
advocates and three judges.

Judges read the fixture's **fixed reference arguments**, not the advocates the
model just produced. This is deliberate — it means judge behaviour is measured
against identical evidence on every model, so advocate variance cannot leak into
the judge comparison.

### Dry run (safe, the default)

```sh
npm run eval:models -- --models openai/gpt-4o-mini --roles advocate
```

A dry run needs no API key. It reports the planned call count and the
conservative maximum cost per model, and sends nothing.

### Real execution

```sh
npm run eval:models -- --models model-a,model-b --max-cost-usd 2.50 --execute
```

`--max-cost-usd` bounds the **whole run**, not one call. Before each call the
harness checks whether that call's conservative maximum still fits the remaining
budget; if it does not, the run stops before the call and the report records
`stopped_reason: budget_exhausted`. Cost already incurred is kept in the report,
including cost for responses that were paid for but failed validation.

Concurrency is available via `--concurrency` and is capped by
`MAX_INFLIGHT_MODEL_CALLS`. Budget reservation is synchronous, so parallel lanes
cannot both pass a check that only one of them fits.

### Options

| Flag | Meaning |
| --- | --- |
| `--models <a,b>` | Model ids to compare. Required. |
| `--roles <advocate,judge>` | Roles to evaluate. Default: both. |
| `--fixtures <id,id>` | Fixture ids. Default: every fixture. |
| `--max-cost-usd <limit>` | Total approved spend. Required with `--execute`. |
| `--concurrency <n>` | Parallel calls, capped by configuration. Default: 1. |
| `--input-price-per-million`, `--output-price-per-million` | Required for unpriced models. |
| `--out-dir <path>` | Report destination. Default: `evaluation/results`. |
| `--execute` | Perform real, paid calls. |

## Where results go, and what is never stored

- Reports are written to `evaluation/results/`, which is **git-ignored**.
- Tracked in Git: the fixtures, the report format document, and one synthetic
  example.
- Never written anywhere: reasoning text, raw provider responses, prompt bodies,
  indictment payloads, and credentials.

`evaluation/REPORT_FORMAT.md` documents every field. `evaluation/example/`
contains a synthetic report produced by a stub provider; regenerate it with
`npm run eval:example`.

## Fixtures

`evaluation/fixtures.json` holds fictional, non-personal cases spanning
operational, clinical-governance, product, public-administration, and
infrastructure decisions, with both balanced and leaning framings. Every
indictment is validated by the production `indictmentSchema`.

**No fixture records an expected verdict.** Tribunal never decides which decision
is correct, so a fixture cannot either. What fixtures do fix is the contract
that output must satisfy, the stance each advocate is assigned, and the evidence
every judge reads.

## Interpreting the metrics

- **Contract pass rate** — share of calls whose output satisfied the production
  validator. It says nothing about whether the reasoning was any good.
- **Validation failure layer and code** — which of the eight validation layers
  rejected the output. This is what makes prompt and model problems actionable:
  `L4:length_violation` and `L5:role_violation` need different fixes.
- **Stance adherence** — advocates only: did the model argue the stance the
  protocol assigned? A model that drifts to the other side is unusable for this
  role regardless of prose quality.
- **Decision distribution** — a descriptive count of judge decisions. It is not
  a vote and is never reduced to a single answer.
- **Cost, tokens, latency, finish reason, fallback count** — the operational
  budget for a real deliberation.

### Why the diversity proxy is not proof of quality

`judge_text_diversity_proxy` is the mean pairwise Jaccard distance between judge
reasoning vocabularies. It measures **word overlap only**.

It cannot show that the three lenses produced genuinely different reasoning. Two
judges can reach materially different conclusions using similar vocabulary and
score low; three rephrasings of one idea can score high. The number is a triage
signal for deciding which outputs a human should read — never a quality score,
and never a basis for choosing a model on its own.

No model is used to grade another model anywhere in this harness. Every reported
number is fixed arithmetic over recorded outcomes.

## Before the first permitted canary

1. Decide the spending limit and who approves it.
2. Put a real `OPENROUTER_API_KEY` in the server environment only — never in
   `.env.example`, never in Git, never in a command-line argument.
3. Confirm the model id and take its prices from the provider's pricing page.
4. Run the dry run first and read the conservative estimate.
5. Run the canary once with `--execute` and an explicit `--max-cost-usd`.
6. Record the contract outcome, cost, latency, and whether the format fallback
   was used.
7. Only then consider a bounded evaluation run.

Live model quality remains unproven until that evaluation has been run and read.
