# PRD: Codex Backend Classifier Prompt-Leak

**Status**: **DIAGNOSIS-ONLY 2026-05-14 PM (Priority P1, blocking)** — earlier "REOPENED" reflagging was based on operational evidence (8+ MANAGER_FALSE_EPIC_COMPLETED strikes in `2026-05-13-b54f2143`) without reconciling against current HEAD. **HEAD reconciliation** (next section) shows the fix this PRD prescribed has already shipped: codex-aware `extractAssistantContent`, `detectOutputFormat` probe, stream-json assistant-line guard, `PromiseTokens` constants module, template scrub, R3/R5 fixture matrix, and trap-door pin are all in place at `v1.74.0`. The operational evidence is real, but the prescribed fix cannot cause it — a different bug class is firing. **DO NOT launch this PRD as a bundle until diagnosis identifies the actual fault.** See `## Diagnostic Plan` below.

## HEAD reconciliation (2026-05-14 PM)

Verified against `c8f64d88` / deployed `v1.74.0`:

| PRD requirement (original) | HEAD reality | Status |
|---|---|---|
| R1 codex-aware `extractAssistantContent` | `extension/src/services/classifier-utils.ts:92` — implements all 3 detection modes verbatim to spec | **SHIPPED** |
| R1 fix-bug: stream-json detection requires `type:"assistant"` JSON | `isAssistantJsonLine` at `classifier-utils.ts:6` enforces this | **SHIPPED** |
| R3 `PromiseTokens` shared constants module | `extension/src/services/promise-tokens.ts` + `types/index.ts:375` enum | **SHIPPED** |
| R3 template scrub (no unbroken `<promise>…</promise>` in deployed templates) | Verified 0 matches in deployed `pickle.md`/`meeseeks.md`/`szechuan-sauce.md`/`pickle-tmux.md` | **SHIPPED** |
| R4 `detectOutputFormat` canonical probe | Exported from `classifier-utils.ts:69`, re-exported via `mux-runner.ts:22` | **SHIPPED** |
| R5 three-fixture matrix + claude regression coverage | `extension/tests/mux-runner-classifier.test.js` (2.6K) + 6 fixtures at `extension/tests/fixtures/iteration-logs/` | **SHIPPED** |
| R3 template scrub test | `extension/tests/template-no-bare-tokens.test.js` (3.7K) | **SHIPPED** |
| R-CCPL-4 trap-door pin (contract enforcement) | `extension/CLAUDE.md` "Codex plain-text classifier MUST detect via block delimiters … stream-json mode MUST require ≥1 type:'assistant' JSON line" | **SHIPPED** |

Inference: the `## Root Cause` / `## Why it's non-deterministic` analysis preserved below describes the *original* bug class, which is fixed. The operational evidence from `2026-05-13-b54f2143` describes a *different* failure that surfaces with the same symptom (`MANAGER_FALSE_EPIC_COMPLETED`).

## 2026-05-14 operational evidence (cause unknown)

- Pipeline `2026-05-13-b54f2143` mux-runner.log MANAGER_FALSE_EPIC_COMPLETED entries:
  - `f54318b1` R-TSPF-1: 3 strikes → operator-healed → relaunched
  - `02252412` R-TSPF-2: 3 strikes → operator-healed → relaunched
  - `dd63fa85` R-TSPF-3: 3 strikes → MANAGER_PERSISTENT_HALLUCINATION (count=4 trip) → operator-healed
  - `4a96afc6` R-TSPF-4: 2 strikes then self-recovered (codex cycle finally stretched naturally)
- The guardrail prevented data loss. The trigger is unidentified — the original prompt-leak fix is in HEAD, so the strikes have a different source.

## Diagnostic Plan

Three competing hypotheses for the b54f2143 strikes. Diagnosis must disambiguate before any new bundle is queued.

| H | Hypothesis | Disambiguation |
|---|---|---|
| H-A | Codex `codex` block legitimately contains the literal token (model echoes prompt body as reasoning/recap) — fix is upstream of `extractAssistantContent` | For each strike, slice the iteration log between the immediately-preceding `codex` delimiter and the next delimiter. Token presence inside → H-A. |
| H-B | Codex delimiter detection has a gap (new block type, renamed delimiter, or whitespace drift) — fix is in `CODEX_DELIMITER_RE` | Grep each strike's iteration log for `^(user|codex|exec|tokens used|reasoning|tool_call)\s*$` count and contrast with raw structural blocks. If a non-matching delimiter appears → H-B. |
| H-C | `classifyCompletion` returned `continue` correctly but the MANAGER_FALSE_EPIC_COMPLETED counter is incremented on a different signal (e.g., manager's prose self-claim, not the classifier) — fix is in mux-runner's strike accounting | Grep mux-runner.log for `MANAGER_FALSE_EPIC_COMPLETED` adjacent to `classifyCompletion`'s decision log. If the strike fires without `classifyCompletion === task_completed` → H-C. |

Additional defense-in-depth probe — R-CCPL-4 trap door already mandates a stderr drift warning when codex-context callers observe `detectOutputFormat === 'plain-text'`. Check b54f2143's mux-runner.log for that warning; presence → drift detected, absence → detection still routing through codex-block mode (H-A or H-C, rules out H-B variants that drop delimiters entirely).

### Diagnostic deliverables

1. Per-strike forensic note (8+ strikes × what mode `detectOutputFormat` returned, what tokens appeared in which block) committed to `prds/research-r-ccpl-b54f2143-2026-05-14.md`.
2. Hypothesis selection (one of H-A/H-B/H-C, or a new H-D the diagnosis surfaces).
3. **Decision**: either (a) draft a fresh, narrow PRD scoped to the actual fault (likely 1–2 tickets), (b) close this PRD via verify-then-close if the strikes were all spurious (e.g., counter increment that the guardrail later self-corrected), or (c) re-open with a corrected `## Problem` section and a real `## Root Cause`.

### Implementer constraint

Diagnosis is read-only forensics — no source changes, no test changes. Run with `--backend claude` if anything spawns. Output is a research note, not a bundle.

## Historical Root Cause Analysis (pre-ship — preserved for reference)

The following two sections describe the **original** bug that the v1.74.0 fix already remediates. They are kept here as background for anyone tracing the parsing-surface lineage. Do NOT use them as a current-HEAD problem statement.

## Problem (HISTORICAL — fixed in v1.74.0)

When `mux-runner.js` runs with `--backend codex`, `classifyCompletion()` non-deterministically returns `'task_completed'` even when the model never emitted `<promise>EPIC_COMPLETED</promise>`. The classifier matches the literal token *inside its own prompt* — codex's plain-text output format defeats the filter that exists to prevent exactly this.

The user-visible failure mode: the per-iteration "all tickets pending" guard fires after 1–2 iterations and the loop exits with `ERROR: EPIC_COMPLETED received but N ticket(s) still pending: ...`. Phase exits non-zero. Tickets that should have been picked up are silently abandoned.

Observed in attractor session `2026-04-24-49a70650` while resuming v10 Phase 1 (T09–T23) on 2026-04-25:
- iter 1: classifier returned `'continue'` (correct, by accident)
- iter 2: classifier returned `'task_completed'` (false positive) → guard fired → exit
- 14 unimplemented tickets silently abandoned, ~10h of planned work lost

## Root Cause

`mux-runner.js::classifyCompletion(output)` reads the full iteration log from disk (`fs.readFileSync(logFile)`), passes it to `extractAssistantContent()`, then scans the result for `<promise>EPIC_COMPLETED</promise>` via `hasToken()`.

The iteration log contains **both** the prompt (instructions sent to the worker) and the response. The prompt body — e.g. `pickle.md` line 148 — instructs the worker to *"output `<promise>EPIC_COMPLETED</promise>` when all tickets are done."* That literal string lives in the log on every iteration of every session, regardless of what the model actually emitted.

`extractAssistantContent()` exists to strip the prompt out before scanning. It works in two passes:

```js
// Pass 1: detect stream-json mode by attempting JSON.parse on each line
let isStreamJson = false;
for (const line of lines) {
    try { JSON.parse(line); isStreamJson = true; break; } catch {}
}
// Pass 2: keep only assistant content if stream-json, else keep everything
for (const line of lines) {
    try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'assistant') parts.push(...);
    } catch {
        if (!isStreamJson) parts.push(line);   // ← plain-text fallback
    }
}
```

For **claude** (default `--output-format stream-json`), every line is a JSON envelope. Detection fires. Only `type:"assistant"` lines survive. Prompt content (`type:"user"`) is filtered out. Safe.

For **codex** (`codex exec`), output is plain text with block delimiters (`user`, `codex`, `exec`, `tokens used`) — no JSON envelopes per line. Stream-json detection is supposed to fail, falling through to "plain text mode keeps everything." That is exactly what the bug exploits: when the filter falls through, the prompt — including `<promise>EPIC_COMPLETED</promise>` — is preserved as "assistant content" and matches.

### Why it's non-deterministic

Stream-json detection is "does *any* line in the log parse as valid JSON." codex output occasionally contains:
- a bare number on its own line (e.g. `tokens used` count, exit code)
- `null` echoed back from a tool result
- a quoted string from `exec` output
- a `{...}` JSON blob from a tool the worker invoked

Any of these flips `isStreamJson` to `true` for that iteration. With stream-json mode on but no `type:"assistant"` lines (codex emits none), `extractAssistantContent` returns the empty string. `hasToken("")` is false. Classifier returns `'continue'` — **correct outcome by accident, not because the parser worked**.

When codex's output happens to contain no JSON-parseable line, plain-text fallback engages, the entire log including the prompt becomes "assistant content," and the prompt's literal `<promise>EPIC_COMPLETED</promise>` matches.

Empirical verification on the v10 session logs:

```
iter1 EPIC_COMPLETED count: 3   ← in the log, all in prompt instructions
iter2 EPIC_COMPLETED count: 3   ← in the log, all in prompt instructions
iter1 isStreamJson detect: true   → extracted len 0 → 'continue'  (accident)
iter2 isStreamJson detect: false  → extracted len 23k → 'task_completed' (false +)
```

Same prompt, same template, same 3 occurrences of the token in both logs. Only the JSON-detection coin flip differed.

## Scope

In:
- `mux-runner.js::extractAssistantContent` — make it codex-aware
- `pickle.md`, `meeseeks.md`, `szechuan-sauce.md`, any other worker template that contains literal promise tokens as instructions — break the substring so it cannot accidentally match
- Regression test that asserts a codex log containing `<promise>EPIC_COMPLETED</promise>` only in the prompt body classifies as `'continue'`

Out:
- Microverse runner (different completion pathway, not affected)
- Claude backend behavior (already correct)
- Other promise tokens (`TASK_COMPLETED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`) — same class of bug; fix landing here covers all of them since they share `hasToken` + `extractAssistantContent`

## CUJs

1. Operator runs `/pickle-tmux --backend codex` on a multi-ticket session. Workers complete tickets one per iteration. Loop continues until either all tickets are Done or the model genuinely emits `EPIC_COMPLETED`. **No false-positive exit.**
2. Operator runs `/pickle-tmux --backend codex --resume <session>` on a session with mixed Done/Todo tickets. Loop picks up at the next Todo, processes through to the end, and only emits `EPIC_COMPLETED` when no Todos remain.
3. Worker prompt instructions still document the promise tokens clearly enough for the model to emit them when needed.

## Requirements

| ID | Priority | Requirement |
|---|---|---|
| R1 | P0 | `extractAssistantContent` MUST distinguish prompt content from model response in codex plain-text logs. |
| R2 | P0 | `classifyCompletion` MUST return `'task_completed'` only when the model's response (not the prompt) contains the EPIC_COMPLETED token. |
| R3 | P0 | Worker template files (`pickle.md`, `meeseeks.md`, `szechuan-sauce.md`, `microverse.md`, `pickle-tmux.md`) MUST NOT contain any classifier-matched promise token in unbroken substring form. The authoritative token list is enumerated at `extension/src/hooks/handlers/stop-hook.ts:170-183` (8 tokens: `EPIC_COMPLETED`, `TASK_COMPLETED`, `ANALYSIS_DONE`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `WORKER_DONE`, `PRD_COMPLETE`, `TICKET_SELECTED`, plus the per-session `state.completion_promise` variable). The template-scrubber test MUST source its blocklist from that file (or a constants module both files import) so renames cannot drift the two surfaces apart. Use a sentinel/escaped form that documents the contract without colliding with the scanner. |
| R4 | P1 | Codex output format MUST be detected explicitly via the block-delimiter rule in R1, not via "stream-json failed → assume plain-text." If a future codex release drops or renames the `user`/`codex`/`exec`/`tokens used`/`reasoning`/`tool_call` delimiters, detection MUST fail loud (CI smoke pinned to `codex --version`) rather than silently regress to the prompt-leaking plain-text fallback. R4 is the *fail-loud* contract; the parser fix lives in R1. |
| R5 | P1 | `mux-runner` regression tests MUST cover: codex log with promise tokens only in prompt → `'continue'`; codex log with promise tokens in model response → `'task_completed'`; claude log with promise tokens in prompt-shaped JSON → `'continue'`. |
| R6 | P2 | When `classifyCompletion` returns `'task_completed'` and the all-tickets-pending guard fires, the runner SHOULD include the iteration log path in the error message so operators can diagnose without grepping logs by hand. |

## Interface Contracts

### `extractAssistantContent(output: string): string`

**Existing signature preserved.** Internal logic gains a third detection mode.

Detection precedence (top wins):

1. **Stream-json**: ≥1 line parses as JSON AND ≥1 of those is `{type:"assistant", ...}`. Keep only `type:"assistant"` and `type:"result"` text content.
2. **Codex plain-text**: ≥1 line matches `/^(user|codex|exec|tokens used|reasoning|tool_call)\s*$/` as a block delimiter. Treat content between a `codex` delimiter and the next delimiter (or EOF) as assistant content. Treat content after `user` / `exec` / `tokens used` / `reasoning` / `tool_call` as non-assistant and drop. **Multi-turn handling**: when the same iteration log contains multiple `user` blocks (codex re-prompted mid-iteration), every `user` block is dropped — only `codex` blocks survive. The classifier scans the union of all surviving `codex` blocks; a token in any one of them counts.
3. **Pure plain-text fallback**: neither detection above. Keep all lines (preserves existing non-codex non-claude callers).

Stream-json detection bug fix: a single non-`type:"assistant"` JSON line (e.g. `null`, `42`, `{type:"system"}`) MUST NOT trigger stream-json mode. Detection requires evidence of *assistant* JSON, not just *any* JSON.

### Classifier (`classifyCompletion`)

Signature unchanged. Behavior change is invisible to callers — same return type, same three values (`'task_completed'` | `'review_clean'` | `'continue'`).

### Promise token format

Worker templates document tokens via a literal-broken form:

```markdown
<!-- Document: when the loop is fully done, output a single line containing
     <promise>EPIC_COMPLETED</promise> -->
Output the **EPIC-COMPLETED promise** ( `<promise` + `>EPIC_COMPLETED</` + `promise>` ) on a line by itself when all tickets are Done.
```

Or — preferred — a single conventional macro the templates reference:

```markdown
When all tickets are Done, output {{TOKEN.EPIC_COMPLETED}} on a line by itself.
```

…with the macro substituted at install time (via `install.sh`) into the actual literal that the model emits. This keeps the source templates substring-clean while the deployed templates contain the literal. **Defensive layer: even if a template author forgets, the codex-aware `extractAssistantContent` already filters prompt content out.**

## Verification

Each requirement maps to one or more checks:

| Req | Check | Command |
|---|---|---|
| R1 | Codex log fixture with prompt-only `EPIC_COMPLETED` returns extracted content with no token | `bun test extension/tests/mux-runner-classifier.test.ts -t 'codex prompt-leak'` |
| R2 | Same fixture: `classifyCompletion` returns `'continue'` | same test |
| R3 | Grep deployed templates: `grep -n '<promise>[A-Z_]*</promise>' ~/.claude/commands/{pickle,meeseeks,szechuan-sauce,microverse,pickle-tmux}.md` returns 0 unbroken matches (matches inside HTML comments or substring-broken forms are fine) | `extension/tests/template-no-bare-tokens.test.ts` |
| R4 | Codex log fixture with `null` on a line by itself does NOT trigger stream-json mode | classifier test |
| R5 | Three-fixture matrix passes | `bun test extension/tests/mux-runner-classifier.test.ts` |
| R6 | Synthetic run that triggers the all-pending guard logs the iteration log path | `extension/tests/mux-runner-guard-logging.test.ts` |

## Test Expectations

Test files:

- `extension/tests/mux-runner-classifier.test.ts` — fixture-driven, covers all 3 detection modes
- `extension/tests/template-no-bare-tokens.test.ts` — scans deployed templates for unbroken promise tokens
- `extension/tests/mux-runner-guard-logging.test.ts` — verifies guard error contains log path

Fixture corpus: `extension/tests/fixtures/iteration-logs/`

| Fixture | Content | Expected classifier |
|---|---|---|
| `codex-prompt-leak.log` | codex plain-text log; `<promise>EPIC_COMPLETED</promise>` appears 3× in prompt body, 0× in `codex` block | `'continue'` |
| `codex-real-completion.log` | codex plain-text log; `<promise>EPIC_COMPLETED</promise>` appears 3× in prompt + 1× in `codex` block | `'task_completed'` |
| `codex-ticket-selected.log` | codex plain-text log; prompt has 3× `EPIC_COMPLETED`; codex block has `<promise>TICKET_SELECTED</promise>` | `'continue'` |
| `claude-stream-json.log` | claude stream-json; prompt-shaped `type:"user"` line embeds `EPIC_COMPLETED`, no assistant emit | `'continue'` |
| `claude-real-completion.log` | claude stream-json; `type:"assistant"` text contains `<promise>EPIC_COMPLETED</promise>` | `'task_completed'` |
| `mixed-json-noise.log` | codex plain-text with one `null` line + prompt-only `EPIC_COMPLETED` | `'continue'` (regression: must NOT flip into stream-json mode and accidentally drop everything) |

## Conformance Check

- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all classifier + template fixtures green
- [ ] Lint passes — 0 new warnings
- [ ] Deployed templates (post `install.sh`) contain zero unbroken `<promise>[A-Z_]*</promise>` substrings outside HTML comments
- [ ] Manual smoke: run `/pickle-tmux --backend codex` on a 3-ticket session, all 3 land, no false `EPIC_COMPLETED`
- [ ] Manual smoke: run the same with `--backend claude`, verify no regression in claude path

## Assumptions

- Codex plain-text format remains stable around block delimiters `user` / `codex` / `exec` / `tokens used`. (Verified against `codex` v0.124.0 and v0.125.0; if a future version changes the format, `extractAssistantContent` will need a new mode added.)
- The classifier is the only token-scanning surface that needs hardening. (Spot-checked: `classifyTicketCompletion` uses the same `extractAssistantContent` + `hasToken` pair, so this fix covers both.)
- No production code emits `<promise>EPIC_COMPLETED</promise>` as data (e.g. in a generated source file under review). If it ever does, the substring-broken template approach plus codex-aware filtering both still hold.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Codex format changes in a future release, breaking the new delimiter detection | Stream-json fallback for codex output is impossible (codex doesn't emit it). Mitigation: pin a `codex --version` smoke test in CI; if format drift is detected, fail loud rather than silently regress to plain-text. |
| Template macro substitution adds install-time complexity | Acceptable — `install.sh` already does template-to-`~/.claude/commands` copy; substitution is one `sed` step. |
| Existing sessions in flight when fix lands have logs already containing the bug pattern | Resume path re-reads the latest iteration log only. As long as the new iteration produces a clean log, classification proceeds correctly. No data migration needed. |
| Other downstream consumers of `extractAssistantContent` rely on plain-text fallback for non-codex non-claude backends | Audit before landing: grep for `extractAssistantContent` callers. Today there is exactly one caller (`classifyCompletion`); the function is module-internal. |

## Business Impact

- Eliminates the silent-loss-of-work failure mode from this bug class. The all-pending guard exists to prevent silent loss; this fix prevents it from firing spuriously and aborting legitimate sessions.
- Restores codex backend as a viable production option. Today, the only safe workaround is `--backend claude`, foreclosing codex's cost advantage on long-running sessions.
- Hardens the contract between worker prompts and runner classifiers. Once promise tokens cannot bleed from prompts into classifier matches, future template authors gain a substantive guarantee instead of a "don't accidentally include the literal token" landmine.

## Coupling with God-Function Remediation Epic

This PRD shares a parsing surface with **T5 (`stop-hook.ts` split, 8-token detectors)** in `prds/archive/bundles/god-functions-remediation.md`. Both depend on a single authoritative enumeration of the promise tokens.

**Ordering**: this PRD lands FIRST. T5 then consumes the tokens-constants module this PRD introduces (or, if no module is introduced, T5 imports the same `stop-hook.ts:170-183` constants the template-scrubber test imports). Landing T5 first risks two simultaneous renames of the token list with no shared source of truth.

**Coordination**: if both PRDs are open at once, the codex-classifier fix MUST extract a shared `extension/src/services/promise-tokens.ts` constants module, and T5's plan must be amended to import from it instead of redeclaring the literals.

## Stakeholders

- **Author**: Gregory Dickson (Pickle Rick)
- **Diagnostician (current phase)**: ad-hoc forensic pass on `2026-05-13-b54f2143` mux-runner.log + per-strike iteration logs; read-only, no source changes. Output is `prds/research-r-ccpl-b54f2143-2026-05-14.md`.
- **Implementer (conditional, post-diagnosis)**: TBD. Only assigned if diagnosis surfaces an actual fault. Backend constraint stays `--backend claude`.
- **Reviewers**: any operator who has run `/pickle-tmux --backend codex`

## References

- Attractor session: `~/.local/share/pickle-rick/sessions/2026-04-24-49a70650/` — session where the bug was first reproduced and diagnosed
- Attractor `MASTER_PLAN.md` § "v10 Phase 1 execution log" → "Upstream pickle-rick-claude bugs surfaced (2026-04-25)"
- `extension/bin/mux-runner.js` lines 140–230 (extractAssistantContent + classifyCompletion + classifyTicketCompletion)
- Related but distinct: `prds/multi-repo-task-state-drift.md` — `depends_on` resolver bug surfaced in the same session, fixed separately by user.
