# Tribunal model evaluation

- Report format: `tribunal-evaluation/1.1.0`
- Generated at: 2026-01-01T00:00:00.000Z
- Execution: **mocked-verification**
- Mode: `execute`
- Structured output: `json_schema`
- Planned calls: 35 (conservative maximum $0.160371)
- Provider calls attempted: 35
- Fixtures: clinic-triage-reallocation, ops-emergency-shutdown, transit-fare-enforcement, utility-boil-notice-delay, vendor-known-defect-release
- Budget: approved $5.000000, spent $0.014000, remaining $4.986000

## Per-model summary

| Model | Contract pass | Stance adherence | Input tok | Output tok | Cost | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `example/synthetic-model` | 85.7% (30/35) | 100.0% | 42800 | 11600 | $0.014000 | 0 |

## `example/synthetic-model`

Validation failures by layer and code:

- `L1:unparseable_output`: 5

| Fixture | Contract pass | Diversity proxy |
| --- | ---: | ---: |
| `clinic-triage-reallocation` | 85.7% | 0.5926 |
| `ops-emergency-shutdown` | 85.7% | 0.5926 |
| `transit-fare-enforcement` | 85.7% | 0.5926 |
| `utility-boil-notice-delay` | 85.7% | 0.5926 |
| `vendor-known-defect-release` | 85.7% | 0.5926 |

## How to read these numbers

- **Contract pass** is the share of calls whose output satisfied the production validator. It says nothing about whether the reasoning was good.
- **Stance adherence** applies to advocates only: it is the share of validated advocates that argued the stance the protocol assigned.
- **Judge decisions** remain individual call records. The report does not derive panel-level decision counts or a preferred result.
- **Diversity proxy** is the mean pairwise Jaccard distance between judge reasoning vocabularies. It is a proxy for wording difference, not evidence of reasoning quality or of real lens differentiation. Two judges can reason very differently in similar words, and boilerplate rephrasing can score high. Use it only to decide which outputs deserve a human read.

No model was used to grade another model. Every number above is fixed arithmetic over recorded run outcomes.
