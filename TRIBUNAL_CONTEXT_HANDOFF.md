# Tribunal — Project Context Handoff

## Purpose of this file

This document transfers the current project context to another computer and a new agentic development session. Read it before proposing an architecture or writing code. Treat the requirements marked **mandatory** as part of the fixed course specification.

## Project summary

Tribunal is a cognified web application that examines one difficult decision from several opposing perspectives. It does not produce a single authoritative answer. A user submits a structured charge sheet, four AI advocates argue both sides, and three AI judges independently return reasoned verdicts. The application displays all three verdicts side by side. The human user remains the final judge.

Core principle:

> Tribunal weighs one hard decision from many sides and never hands the user a single merged answer.

## Mandatory protocol

The complete deliberation has seven model calls:

1. The user submits a charge sheet.
2. Four advocates work independently:
   - Advocate 1 argues that the act was justified.
   - Advocate 2 independently argues that the act was justified.
   - Advocate 3 argues that the act was not justified.
   - Advocate 4 independently argues that the act was not justified.
3. The four advocates may run in parallel because they do not depend on one another.
4. Three judges receive the charge sheet and all four advocate arguments.
5. Each judge reasons and rules independently.
6. The three judges may run in parallel after all advocate arguments are ready.
7. The protocol returns three verdicts side by side.

**The application must never:**

- average the verdicts;
- select a majority verdict;
- calculate a consensus;
- ask another model to merge or summarize the verdicts into a final decision;
- silently replace a failed call with a default verdict.

The user, not the software, interprets disagreement and makes the final decision.

## Charge sheet

The first course version defines a three-part charge sheet:

1. **Defendant** — who or what is being judged.
2. **Act** — the action or decision being examined.
3. **Exact question** — the precise yes/no question the Tribunal must address.

The charge sheet is a specification, not unstructured free text. Validation must reject an incomplete sheet before any paid model call begins.

Example shape:

```json
{
  "defendant": "Jon Snow",
  "act": "Jon Snow killed Daenerys Targaryen",
  "question": "Was the act justified?"
}
```

The canonical classroom example is only an example and must not be hard-coded into the product.

## Suggested web architecture

Use four conceptual parts:

### 1. Browser / frontend

Responsibilities:

- render the charge-sheet form;
- validate basic completeness for immediate feedback;
- submit the case to the backend;
- show pending, failed, partial, and completed states honestly;
- present three verdicts together, without implying a winner;
- show verdict first, reasons second, and detailed advocate arguments below or on demand;
- show a past-cases view when persistence is implemented.

The intended interaction is deliberately simple: a form and a submit button. Avoid decorative controls that do not support the task.

The browser is untrusted. It must not contain API secrets, authoritative validation, private prompts, or protocol logic that a user could alter.

### 2. Backend / API

Responsibilities:

- perform authoritative charge-sheet validation;
- hold the OpenRouter API key;
- load the seven versioned prompts;
- orchestrate the advocate and judge stages;
- enforce dependency order: advocates first, judges second;
- run independent calls in parallel within each stage;
- validate the structure of model responses;
- apply timeouts, retry limits, token limits, and spending limits;
- record every call and return an explicit failure state;
- never merge the three judge verdicts.

Suggested high-level endpoint:

```text
POST /api/cases
```

The first implementation may use a synchronous request if it reliably completes within platform limits. If calls exceed those limits, move to an asynchronous job model:

```text
POST /api/cases           -> create case/job
GET  /api/cases/:id       -> retrieve state and results
GET  /api/cases           -> list past cases
```

Do not choose synchronous versus asynchronous execution without checking the actual hosting timeout.

### 3. Database

Persist at least:

- cases and charge sheets;
- advocate arguments;
- judge verdicts and reasons;
- prompt names and versions;
- model/provider identifiers;
- raw model responses when appropriate for auditing;
- normalized responses used by the UI;
- call status and errors;
- input tokens, output tokens, estimated cost, and latency;
- timestamps and deliberation status.

SQL is a reasonable default because the entities and relationships are clear. Supabase/Postgres is recommended by the course, but an equivalent managed database is acceptable.

### 4. Deployment

The course suggests Netlify for hosting and Supabase for backend services, authentication, storage, and database. These are recommendations rather than strict requirements. Keep provider-specific code behind small interfaces where practical.

OpenRouter is the required model gateway in the shared project specification.

## Suggested domain model

```text
Case
  id
  defendant
  act
  question
  status
  created_at
  completed_at

AgentRun
  id
  case_id
  role               advocate_for | advocate_against | judge
  role_instance      1..n
  prompt_version
  provider
  model
  status
  input_tokens
  output_tokens
  estimated_cost
  latency_ms
  raw_response
  error
  created_at

Argument
  id
  case_id
  agent_run_id
  position           justified | not_justified
  reasoning

Verdict
  id
  case_id
  agent_run_id
  decision           justified | not_justified
  reasoning
```

The exact schema may change, but retain provenance: every visible argument or verdict must be traceable to its prompt version, model, call record, cost, and timestamp.

## Prompt requirements

There are seven agent prompts: four advocate prompts and three judge prompts. They must be:

- stored as project files, not hidden only in a provider dashboard;
- written precisely;
- independently identifiable;
- version-controlled;
- reviewed like code;
- connected to recorded prompt-version metadata in each call.

Do not invent the final prompt wording without a separate prompt-design pass. The initial prompts should constrain role, inputs, output schema, forbidden behavior, and treatment of missing information.

Judges must evaluate the case independently. A judge must not see another judge's verdict.

## Response contracts

Prefer structured model outputs. A possible initial contract is:

```json
{
  "decision": "justified",
  "reasoning": "Reasoned explanation grounded only in the supplied charge sheet and arguments."
}
```

For advocates:

```json
{
  "position": "justified",
  "reasoning": "Argument grounded only in the supplied charge sheet."
}
```

Do not trust JSON merely because it parses. Validate allowed enum values, required fields, length limits, and consistency with the assigned role. Preserve malformed or failed calls as failures; never turn them into a verdict.

## Cognified-software design principles

The model is a runtime component, not only a development tool. Tribunal inherits four properties of model calls:

1. **Variable** — the same input may produce different reasoning or even a different verdict.
2. **Costly** — every input and output token has a price.
3. **Slow** — calls take seconds rather than ordinary-code milliseconds.
4. **Fallible** — an answer can be fluent, well-formed, and still wrong.

Draw the intelligence boundary carefully. Use deterministic code for form validation, authorization, storage, orchestration, accounting, and rendering. Use models only for advocacy and judgment, where reasoning is the product.

## Token economics and latency

Course estimates for the final Tribunal:

- seven calls per deliberation;
- roughly 17,000 tokens for a complete case;
- judges consume most of the tokens because each reads all four advocate arguments;
- seven sequential calls may take about 21 seconds;
- advocates in parallel followed by judges in parallel may reduce the workflow to about 6 seconds.

These are design estimates, not performance guarantees. Measure real models in the implemented system.

Required economic controls:

- record input and output tokens for every call;
- record estimated monetary cost per call and per case;
- cap maximum output tokens;
- set a hard maximum number of calls per deliberation;
- set bounded retry rules;
- set a maximum cost per case;
- use prompt caching for repeated charge-sheet/context prefixes when the selected provider supports it;
- choose the least expensive model that is good enough for each role;
- do not sacrifice judge quality merely to minimize cost;
- expose operational failures rather than spending indefinitely on retries.

Parallelism reduces user-visible latency, not total token consumption.

## Interface requirements

The interface specification should define four things:

1. **User flow** — including incomplete, loading, partial-failure, full-failure, and completed paths.
2. **Information hierarchy** — three verdicts together; verdicts before reasons; deeper arguments below.
3. **Interaction model** — a focused form and submit action, without unnecessary controls.
4. **Feedback design** — clear progress and truthful error states.

Important safety rule:

> A failure must look like a failure, never like a verdict.

Never use `not justified`, `justified`, or any other substantive decision as a fallback/default value.

## Recommended implementation sequence

Implement in small, verifiable milestones. Preserve the progression in Git history.

### Milestone 0 — Repository and evidence trail

- initialize one Git repository for Tribunal;
- add this context file;
- add a README with setup and architecture notes;
- add `.env.example`, never real keys;
- decide formatting, linting, testing, and type-checking gates;
- commit before asking an agent to make a non-trivial change.

### Milestone 1 — Deterministic vertical slice

- charge-sheet form;
- backend validation;
- database persistence;
- a fake/deterministic model adapter;
- one displayed opinion;
- explicit loading and failure states;
- tests for the request cycle.

This proves browser -> backend -> database -> response before paid inference is introduced.

### Milestone 2 — One live model

- add the OpenRouter adapter on the server;
- keep the key secret;
- validate structured output;
- log tokens, cost, latency, model, and errors;
- add strict timeout and retry bounds.

### Milestone 3 — Four advocates

- implement the two-for/two-against role prompts;
- run all four in parallel;
- store and display each argument separately;
- verify that one failed advocate cannot silently become a valid argument.

### Milestone 4 — Three judges and fixed protocol

- wait until all required advocate results are available;
- run three judges independently and in parallel;
- ensure no judge receives another judge's result;
- display all three verdicts side by side;
- add a test that fails if any merging/majority logic is introduced.

### Milestone 5 — Auditability and economics

- past-cases page;
- prompt/model provenance;
- per-call and per-case token/cost reporting;
- economic guardrails;
- prompt caching where supported;
- failure/retry audit trail.

### Milestone 6 — Verification and deployment

- end-to-end tests for the full request cycle;
- tests for incomplete charge sheets and malformed model output;
- tests for partial and full model failure;
- tests for orchestration order and parallelism;
- security review for key leakage and untrusted input;
- deployed environment with health checks and documented rollback.

## Definition of done for the first implementation phase

The initial phase is complete when:

- a user can submit defendant, act, and exact question;
- authoritative backend validation rejects incomplete input;
- a case is persisted;
- the backend calls one model through a replaceable adapter;
- the result or failure is stored and displayed truthfully;
- the API key is never delivered to the browser;
- token usage, cost, latency, status, model, and prompt version are logged;
- automated tests cover success, invalid input, malformed response, timeout, and provider failure;
- setup works from a fresh clone using documented commands and `.env.example`;
- the repository contains a clear audit trail of specifications, prompts, decisions, tests, and atomic commits.

The seven-agent panel is a later milestone, but the first-phase architecture must not prevent it.

## Non-goals for the first phase

- authentication unless specifically required for the first deployment;
- payments or subscription billing;
- automatic final decisions;
- majority voting or verdict aggregation;
- complex case attachments;
- user-editable agent prompts;
- model fine-tuning;
- premature multi-provider abstraction beyond the OpenRouter adapter;
- elaborate UI animation or decorative dashboards.

## Engineering discipline expected by the course

The repository is the evidence. Maintain:

- specifications and charge sheets;
- seven versioned agent prompts as they are introduced;
- human-written context files;
- an honest, atomic commit history;
- commits before non-trivial agent invocations;
- verification gates that catch real failure modes;
- test and verification results;
- rationale for architectural decisions;
- a final merge-ready state.

Agent output is a hypothesis until it passes a defined verification gate.

## Recommended initial technology choices

These choices are reasonable defaults, not fixed requirements:

- TypeScript end to end;
- React-based frontend;
- a server or serverless API with timeouts suitable for model orchestration;
- Supabase/Postgres for persistence;
- OpenRouter for model calls;
- schema validation such as Zod;
- a test runner suitable for unit and integration tests;
- browser-level end-to-end testing for the final request cycle;
- Netlify or an equivalent deployment platform.

Before scaffolding, confirm the exact framework and hosting limits. Avoid choosing a serverless function whose maximum execution time cannot support the deliberation workflow.

## Open decisions for the new session

Resolve these explicitly before implementation:

1. Exact frontend and backend framework.
2. Synchronous request versus asynchronous job orchestration.
3. Database schema and retention policy for raw model output.
4. Initial OpenRouter model for the one-model milestone.
5. Models assigned to advocates and judges in the final version.
6. Exact structured-output schemas.
7. Retry policy for malformed, timed-out, or failed calls.
8. Whether a case with one failed advocate proceeds or fails the deliberation.
9. Whether a case with one failed judge shows two verdicts plus an explicit failure, or requires a retry before completion.
10. Authentication and privacy requirements for stored cases.
11. Maximum cost and latency budgets per case.
12. Data deletion and audit-log retention rules.

Do not let an implementation agent silently decide these product policies.

## Security notes

- Never expose the OpenRouter key in frontend code or browser network payloads.
- Treat all user case content and model output as untrusted data.
- Do not let case text override system/developer instructions.
- Use least-privilege database credentials.
- Validate and constrain all model outputs before rendering or storing normalized fields.
- Escape rendered content and avoid unsafe HTML injection.
- Avoid logging secrets or unnecessary personal data.
- Bound the economic blast radius with call, token, retry, and cost limits.

## Available course source material

All seven course presentations are available in the sibling course-material folder. They should be treated as authoritative local course sources. The filenames are:

```text
ASE26 lesson 1 111.pptx
ASE26 lesson 2.pptx
ASE26 lesson 3.pptx
ASE26 lesson 4.pptx
ASE26 lesson 5.pptx
ASE26 lesson 6.pptx
ASE26 lesson 7.pptx
```

Most relevant slides:

- Lesson 4, slide 27 — complete Tribunal protocol: charge sheet -> four advocates -> three judges -> three unmerged verdicts.
- Lesson 4, slides 33–45 — browser, backend, database, deployment, request cycle, and initial web-app build.
- Lesson 5, slides 13–20 — interface and failure-state requirements.
- Lesson 5, slides 27–38 — cognified software, model boundary, prompts, variability, and failure.
- Lesson 5, slides 39–46 — token cost, approximately 17,000 tokens, caching, model choice, latency, parallelism, and economic blast radius.

## Instruction for the next coding agent

Start by reading this file, inspecting the repository, and confirming that the seven presentation files listed above are accessible. Review at least the referenced slides before finalizing the specification. Do not immediately scaffold a large application. First:

1. Report the current repository and source-material state.
2. Verify the mandatory protocol against Lesson 4, slide 27, and the economics against Lesson 5, slides 39–46.
3. Propose the smallest Milestone 1 architecture.
4. List assumptions and unresolved decisions.
5. Write a short implementation specification with testable acceptance criteria.
6. Wait for approval of any product decision that changes the mandatory protocol.
7. Implement one verified vertical slice at a time.

Preserve the fixed essence of Tribunal throughout: four advocates, three independent judges, three unmerged verdicts, and a human final decision.
