# Verification gates

Nothing enters the main line without passing a gate. The gates run
mechanically, with nobody present, and refuse a change rather than warning
about it.

This document describes the gates, how to install them, and what they
deliberately do not establish.

## Why these exist

Every check described here already existed in this project as something a person
ran by hand. That is not a control. Two things went wrong under that regime, and
both are the reason this module exists:

1. **A scan reported a clean result while being broken.** A Cyrillic scan used
   `grep -P`, which failed on the machine's locale. The error was discarded, so
   "no matches" was indistinguishable from a genuine pass. The check had stopped
   working and said nothing.
2. **The checks depended on somebody remembering.** A gate that runs when
   convenient is absent exactly when it matters.

So every gate here carries a **self-test**. Before a gate is allowed to report a
clean result, it must first prove it can fail: it is handed a known-bad sample it
must flag, and a known-good sample it must not. A gate whose self-test fails is
reported as failed, never as passed.

## Installing the hooks

```sh
npm run hooks:install
```

This sets `core.hooksPath` to the tracked `.githooks` directory. Hooks living in
`.git/hooks` are private to one clone and vanish with it, so they cannot be a
project control; a tracked directory can be.

Run it once per clone. Everyone who runs it gets the same gate.

## The gates

| Gate | Refuses | Severity |
| --- | --- | --- |
| `secrets` | Credential-shaped literals in tracked content. | blocking |
| `language` | Cyrillic in tracked file names or content. | blocking |
| `protected-paths` | Unannounced changes to prompts, the prompt lock, or migrations. | blocking |

### secrets

A committed secret is exposed for the life of the repository. History is
permanent, every clone carries it, and deleting it later does not undo the
exposure. Treat any committed key as compromised and rotate it.

Recognised shapes include OpenRouter, OpenAI, Anthropic, AWS, GitHub, and Google
keys, private key blocks, and hard-coded `Authorization` headers.

A finding **never reproduces the secret**. It reports a redacted preview and a
length, because a gate that echoes what it found into a terminal, a CI log, or a
report has moved the secret rather than caught it.

Tests need to name credential-shaped strings in order to assert that redaction
works. Those are allowed only when the value says of itself that it is not real
(`sk-or-v1-value-that-must-never-be-printed`), so the exemption cannot quietly
cover a live key.

### language

Tracked code, comments, interface copy, and documentation are English only. The
check runs in process: no shell, no locale dependency, no discarded error.

### protected-paths

Prompts, the prompt lock, and migration history carry product meaning that a
passing test suite does not defend. A prompt edit changes what the models are
asked without changing any assertion. A migration edit rewrites history other
environments have already applied.

These are not forbidden — they are made deliberate. Record the decision in the
commit message:

```
feat: sharpen the judge contract

Protected-change: prompt-change
```

| Path | Token |
| --- | --- |
| `prompts/**` (except the lock) | `prompt-change` |
| `prompts/prompts.lock.json` | `prompt-lock` |
| `migrations/**` | `migration` |

Acknowledging one area does not unlock another, and the token must appear on its
own `Protected-change:` line — prose that happens to mention it does not count.

The gate cannot judge whether the change is correct. It only refuses to let it
pass unannounced.

## Running the gates by hand

```sh
npm run gate                 # staged content, the same check the hook runs
npm run gate -- --tracked    # every tracked file
npm run gate:merge           # full merge-readiness evidence pack
```

The staged scope reads staged blobs, not the working tree, because the commit is
what is being gated.

The tracked scope exists because a file can become non-compliant without being
touched: a rule tightens, or an earlier commit predates the gate. Only a full
sweep finds that. Acknowledgement is skipped in that scope, since there is no
commit message to read.

## The Merge-Readiness Pack

```sh
npm run gate:merge
```

Evidence needs a settled form at the gate. The pack establishes five things, and
each is shown by evidence, never by assertion:

| Item | Established by |
| --- | --- |
| Functional completeness | `npm run build`, `tsc --noEmit` |
| Sound verification | `npm test`, with its pass/fail/skip counts |
| Engineering hygiene | the gates above, plus `git diff --check` |
| Rationale | the commit subjects on the branch |
| Audit trail | commit count and changed-file summary against the merge base |

An item with **no** evidence is reported as **unproven**, never assumed
satisfied. An item whose evidence failed is reported as **failed**. The rationale
is the one item proven by a written statement rather than by a command, because
intent cannot be executed.

The pack is written to `evaluation/results/`, which is git-ignored.

## What the gates do not establish

- **They do not establish that any live model behaves well.** No gate makes a
  paid call. Model quality is a separate question, addressed by the tooling in
  [LIVE_EVALUATION.md](./LIVE_EVALUATION.md), and it remains unmeasured.
- **They do not replace review.** Cheap gates run first so that human attention
  is never spent on work the tests already reject. The human gate stays at the
  merge boundary.
- **A green suite is not proof of correctness.** The tests and the code were
  often written together, so a passing suite shows the code agrees with itself.
  The gates catch classes of fault that tests do not: a credential, a language
  violation, an unannounced change to a protected path.

## If a gate is wrong

Fix the gate, not the bypass. `--no-verify` defeats the control precisely on the
day it would have caught something. If a finding is a false positive, tighten the
rule and add a test that pins the new behaviour.
