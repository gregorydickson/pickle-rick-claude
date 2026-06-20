# Council of Ricks v1.50.0 — JSON Directive + Per-Branch Sharding

## Summary

Replace the markdown-scraped directive contract in the Council of Ricks stack-review feature with a typed JSON contract as the source of truth, and shard Phase B category subagents per-branch on large stacks. Markdown directive becomes human-readable output only; no parser depends on it. Eliminates the whole class of "prompt drifted from parser" silent failures that drove v1.49.0 → v1.49.3.

---

## Context for a Cleared-Session Agent

This PRD is self-contained. An agent implementing it should read this document first, then read the files it references. No prior conversation history is required.

### The project

`pickle-rick-claude` (Claude Code extension) lives at:
- **Repo root:** `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/`
- **Git:** regular `git` (NOT `gt` / Graphite — Graphite is used for other repos in the workspace, see `loanlight/CLAUDE.md`). Use `gh` CLI for GitHub.
- **Runtime:** TypeScript 5.9 / Node 25+ / ESM only
- **Test framework:** `node --test` against compiled JS (`tests/*.test.js` only — no `*.test.ts`)

### Build/deploy flow (canonical)

1. Edit source only:
   - TS: `extension/src/**/*.ts` — compiles to `extension/bin/**/*.js`
   - Commands: `.claude/commands/*.md`
   - Settings: `extension/pickle_settings.json`
2. Build: from `extension/`, run `npx tsc`
3. Deploy: from repo root, run `bash install.sh` — rsyncs source → `~/.claude/pickle-rick/` and command prompts → `~/.claude/commands/`
4. **Never edit deployed files** (`~/.claude/pickle-rick/` or `~/.claude/commands/`). Edit source, then `bash install.sh`.

### Release gate (must pass before tagging)

From `extension/`:
```bash
npx tsc --noEmit && \
npx eslint src/ --max-warnings=-1 && \
npx tsc && \
git diff --exit-code bin/ && \
npm test
```

Pre-existing known flake: `tests/refinement-watcher.test.js` occasionally times out on `node 25.x` — unrelated to Council of Ricks, document and move on if it fails.

### Required code patterns (from `CLAUDE.md`)

All mandatory — lint/release enforces them:

- **CLI guard pattern** (for every bin entrypoint):
  ```ts
  if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { /* main */ }
  ```
- **Error handling** — never cast; always guard:
  ```ts
  const msg = err instanceof Error ? err.message : String(err);
  ```
  The `safeErrorMessage(err)` helper in `extension/src/services/pickle-utils.ts` is the preferred form.
- **Hook decisions** — `"approve"` or `"block"` only, never `"allow"`.
- **Extension path** — `~/.claude/pickle-rick` (never `.gemini`).

### Versioning (from `CLAUDE.md`)

SemVer `<Major>.<Minor>.<Patch>` in `extension/package.json`:
- **Major** — breaking state schema, CLI args, hook contracts
- **Minor** — new features, new commands/flags, prompt additions
- **Patch** — fixes, refactors

This PRD is a **minor bump to 1.50.0** — internal directive contract changes but publisher CLI surface is preserved.

### Greenfield policy (from user memory)

- Do NOT write backward-compat shims, legacy aliases, or migration helpers.
- Do NOT document removed features with `// removed X for Y` comments.
- If something is unused, delete it.
- Tests should assert current behavior; do not keep "just in case" assertions for deleted code paths.

---

## Motivation

### The pattern

Four consecutive hardening patches on `council-publish` in a single day:

| Version | Commit | What it closed |
|---|---|---|
| v1.49.0 | `22b8b02` | feat: parallel rounds via Agent fan-out + size-tier scaling |
| v1.49.1 | `bf207f7` | fix: directive contract + publisher hardening |
| v1.49.2 | `9af0e09` | fix: silent-failure hardening (5 modes closed) |
| v1.49.3 | landed pre-PRD | fix: cross-contamination, parse-error silent `skipped_no_pr`, repo_path validation, unknown-flag rejection, trunk-only warning, fence-aware round extraction |

Each review finds 5–13 new silent-failure modes. Every prompt refactor or reviewer's imagination surfaces a new edge case — backticks, code fences, per-branch tables with a `Branch` column, warning prefixes on `gh pr list`, literal quoted `## Round N:` inside fences, etc.

### The root cause

The directive contract is a free-form markdown document. Both:
- The main agent (LLM) WRITES markdown with specific formatting rules.
- The publisher (`council-publish.ts`) READS markdown with regex/scanner heuristics.

Every mismatch is a silent failure — the publisher scrapes the wrong rows or drops them entirely. Hardening the scanner just moves the next failure mode elsewhere. This class of bug is **structurally unfixable by patching the parser**.

### Orthogonal scaling gap

Size-tier scaling exists today (v1.49.0) but scales round count only (xs→xxl maps to 2→7 rounds). A single B8 Szechuan subagent reviewing 20,000 LOC across a 5-branch stack either runs out of context or produces shallow output. B-category subagent workload does not scale with stack size; only the round iteration count does.

### Why fix now

The user approved a "permanent fix" over more patching (see conversation → rather than v1.49.4, land a structural fix that eliminates the failure class).

---

## Current State — what exists today (pre-PRD)

### Files in scope

| Path | Lines | Role |
|---|---|---|
| `.claude/commands/council-of-ricks.md` | ~520 | The slash-command prompt the main agent receives |
| `extension/src/bin/council-publish.ts` | ~520 | Publisher TS source (post-v1.49.3) |
| `extension/bin/council-publish.js` | — | Compiled output (regenerated by `npx tsc`) |
| `extension/tests/council-publish.test.js` | ~600 | Unit tests, gh-mocked |
| `extension/tests/council-publish-cli.test.js` | ~170 | CLI tests, spawnSync |
| `extension/pickle_settings.json` | — | Contains `default_council_min_rounds`, `default_council_max_rounds`, `default_council_publish` |
| `extension/szechuan-sauce-principles.md` | — | Principles reference copied into session as `council-principles.md` |

### Current flow (what we're replacing)

1. **Setup (Steps 1–9.5 of prompt)**
   - Detect prereqs (`gt`, `tmux`), run gate checks (CLAUDE.md exists, lint passes, arch lint rules exist, stack ≥ 1 branch)
   - Parse flags: `--min-iterations`, `--max-iterations`, `--repo`, `--gitnexus`, `--no-codex`, `--codex-timeout`, `--no-publish`
   - Read `pickle_settings.json`, parse project `CLAUDE.md` → `council-claude-rules.json`
   - Copy `szechuan-sauce-principles.md` → `council-principles.md`
   - Detect Codex companion readiness
   - Discover Graphite stack, compute size tier from LOC/files → `council-stack.json`
   - Initialize session via `extension/bin/setup.js`, launch `mux-runner.js` in tmux
2. **Review round (Step 10+ of prompt, per mux-runner iteration)**
   - **Phase A** — serial in main agent — build `historical-brief.md` (git log, in-file NOTE/IMPORTANT comments, gh PR history)
   - **Phase B** — parallel Agent fan-out — 8 unconditional categories (B1 Stack Structure, B2 CLAUDE.md Compliance, B3 Contract Discovery, B4 Cross-Branch Contracts + Combinatorial, B5 Test Coverage + Migration Safety, B6 Security, B8 Szechuan Principles Sweep, B9 Polish + Trap Doors) + conditional B7 Migration Hygiene
   - **Phase C** — parallel Agent fan-out — 1 per-branch `C_correctness` subagent per non-trunk branch + 1 `C_codex` sweep (sequential checkouts inside, but one Agent call)
   - **Phase D** — serial in main agent — false-positive filter, confidence filter (`conf < 80` dropped), COUNCIL×CODEX dedupe, severity sort, trap-door consolidation, write `council-directive.md` (markdown), append round record to `council-of-ricks-summary.md`
3. **Approval gate (Step 16)** — emits `<promise>THE_CITADEL_APPROVES</promise>` only when all four hold: (1) current_round ≥ min, (2) last two summary `## Round N:` headers both end with `— clean round.`, (3) no unconditional category skipped across those two rounds, (4) zero P0/P1 findings across those two rounds.
4. **Publish (Step 17.7, session end)** — runs `council-publish.js <SESSION_ROOT>` once, at approval OR exhaustion. Publisher:
   - Reads `council-stack.json` (branches, trunk, repo_path, codex_enabled)
   - Reads `council-of-ricks-summary.md` → extracts `## Round N:` header lines as outcome bullets
   - Reads `council-directive.md` → `findingsForBranch(directive, branch)` scrapes `### Findings` table, `trapDoorsForBranch(directive)` scrapes `## Trap Doors` section
   - For each non-trunk branch: composes body, resolves PR via `gh pr list --head <branch> --state all --json number,state,updatedAt`, posts via `gh pr comment <N> --body-file <path>`
   - Idempotent per branch via `<SESSION_ROOT>/.published/<slug>` markers (non-zero-size check)

### Functions being deleted in this PRD

From `extension/src/bin/council-publish.ts`:

- `readLatestDirective(directivePath: string): string` — reads `council-directive.md`, regex-splits on `^# Council Directive\b`, returns latest section
- `findingsForBranch(directive: string, branch: string): string[]` — scans for `### Findings`/`## Findings` section, parses table rows, matches Branch column
- `trapDoorsForBranch(directive: string, _branch: string): string` — scans for `## Trap Doors` section, returns body until next `##`

From `.claude/commands/council-of-ricks.md`:

- The "Required output schema" embedded in Step 15 step 3 (moves to shared schema artifact)
- All markdown formatting rules in Step 16: column-order claims, backtick rules, H2/H3 contracts

### Known-good invariants that MUST survive the refactor

- `<SESSION_ROOT>/.published/<slug>` markers remain the idempotency key (non-zero size = published).
- `council-publish` CLI: `council-publish <SESSION_ROOT> [--dry-run]`. Exit 0 on success, 1 on error, 2 on unknown flag.
- `CouncilPublishError` thrown for: missing session_root, missing `council-stack.json`, missing required fields, trunk not in branches, `repo_path` doesn't exist or is not a directory.
- Publish is idempotent — re-running after partial success only posts missing comments.
- On `gh auth` failure, publisher writes body files to `council-comments/<slug>.md` but does not post; per-branch result outcome `skipped_no_gh`.
- Per-branch failures do not abort the sweep; each branch records its own outcome.
- `extractRoundOutcomes(summaryPath)` stays as-is (fence/blockquote-aware). It consumes `council-of-ricks-summary.md`, not the directive; unrelated to this refactor.

### Recent review findings (context for decisions)

Two agents reviewed the v1.49.2 surface in parallel before this PRD:

**Prompt review (12 findings).** HIGH issues: backtick rule contradiction with publisher behavior; phantom "heading-level contract" in §8 that the publisher doesn't enforce; column-order "load-bearing" claim untrue (publisher looks up Branch by name). MEDIUM issues: ambiguous line schema (`number` or `"range"`), trap_door_candidate schema/render mismatch, CLI `--min-iterations` silently inflates effective_max, parse_error path has no halt mechanism.

**Publisher review (13 findings).** HIGH issues: `findingsForBranch` scans ALL tables with a Branch column → per-branch H3 tables cross-contaminate; `parsePrList` on malformed JSON returns `[]` → classified as `skipped_no_pr` silently. MEDIUM issues: `extractRoundOutcomes` counts `## Round N:` inside fenced code; legacy-integer fallback unreachable after `break`; no validation `repo_path` exists; etc.

**v1.49.3 closed**: all HIGH findings + the MEDIUM silent-failure class. But the underlying pattern — "LLM markdown output → regex parser" — is the root cause.

---

## Goals

1. `council-directive.json` is the single source of truth for publisher input. Markdown directive is decorative and free-form.
2. Every subagent returns a shape-validated JSON payload; main agent fails loud on schema violation.
3. For stack tier ≥ `l`, B-categories fan out per-branch (N_branches × N_categories concurrent subagents) instead of once stack-wide.
4. Delete all markdown-scraping in the publisher. Net code reduction.
5. Zero backward compatibility with v1.49.x directive format. Hard cutover.
6. Release gate stays green. Existing documented flakes (refinement-watcher) are unaffected.

## Non-Goals

- Bounded-concurrency `gh pr comment` in the publisher. Publish step is seconds per branch; not worth the complexity.
- Per-Agent-tool-call timeout. Defer unless confirmed the Agent tool has no built-in timeout.
- Changing the `council-publish` CLI surface (`council-publish <SESSION_ROOT> [--dry-run]` stays).
- Changing the approval-gate promise tag on publish failure (`THE_CITADEL_APPROVES` still fires even if some comments fail to post; Step 17.7 current behavior preserved).
- Changing the mux-runner, `setup.js`, or session root layout.
- Refactoring `extractRoundOutcomes` (different file path, different purpose, untouched).
- Making the approval gate (Step 16) read from JSON. The approval gate reads `council-of-ricks-summary.md` headers — that file stays markdown because it's human-facing audit log, not parser-critical.

---

## Design Overview

### Directive as JSON — atomic write

Each round, the main agent writes `<SESSION_ROOT>/council-directive.json` via `write-to-tmp + fs.rename`. Never torn. It also writes `council-directive.md` for humans, but the markdown is free-form: no required sections, no required columns, no required heading levels. The publisher never reads it.

### Typed Subagent I/O Contract

Every Phase B / Phase C subagent receives a per-category JSON schema inline in its prompt. Every subagent's final message MUST contain exactly one fenced ```json block conforming to that schema. The main agent `JSON.parse`s and shape-checks each payload on arrival. Malformed payload → record category as `skipped` with `skip_reason: "schema validation failed: <jsonpath>"` and the round demotes to partial per existing Step 17 rules.

A validator lives at `extension/src/services/council-schema.ts` — pure functions, unit-tested. Validator is tolerant of extra unknown fields (forward compat) but strict on missing required fields and enum/range violations.

### Per-Branch B-Category Sharding

For stack tier ∈ `{l, xl, xxl}`, main agent spawns `N_branches × N_unconditional_categories` B-subagents, each scoped to one (branch, category) pair. Each subagent's prompt points it at that one branch's diff only, with the shared historical brief and principles files. For xs/s/m, keep current stack-wide fan-out (cheaper, still adequate).

Phase D synthesis concatenates typed findings arrays across shards. Dedupe key is `(branch, file, line, rule, description)` — includes branch so cross-branch findings at the same `file:line` are kept separately.

### Publisher refactor

Delete `readLatestDirective`, `findingsForBranch`, `trapDoorsForBranch`. Add `readDirectiveJson(sessionRoot): Directive` that reads + validates or throws `CouncilPublishError`. `composeBody` accepts typed findings and trap doors and renders markdown deterministically end-to-end — the publisher owns the rendered format.

---

## Data Contracts

### `council-directive.json` — Directive (top-level)

```json
{
  "schema_version": 1,
  "round": 3,
  "codex_enabled": true,
  "project_rules_ref": "council-claude-rules.json",
  "stack_overview": {
    "trunk": "main",
    "branches": ["feat/one", "feat/two"],
    "issue_counts": { "P0": 1, "P1": 2, "P2": 0, "P3": 0, "P4": 0 },
    "codex_verdicts": {
      "feat/one": "approve",
      "feat/two": "needs-attention"
    }
  },
  "branches": [
    {
      "name": "feat/one",
      "pr_purpose": "Short one-liner from PR body, nullable",
      "findings": [
        {
          "severity": "P0",
          "confidence": 90,
          "source": "COUNCIL",
          "file": "src/auth/session.ts",
          "line": 42,
          "line_range": null,
          "rule": "session-security",
          "description": "Missing rotation on refresh",
          "recommendation": "Force-rotate session id on refresh",
          "data_flow": null,
          "scenario": null,
          "snippet_before": null,
          "snippet_after": null
        }
      ]
    }
  ],
  "trap_doors": [
    {
      "path": "src/auth/session.ts",
      "constraint": "session id must rotate on refresh",
      "why_it_breaks": "reuse window allows hijack",
      "what_must_hold": "force-rotate on every refresh path"
    }
  ]
}
```

**Validation rules:**

- Required top-level keys: `schema_version`, `round`, `codex_enabled`, `branches`, `trap_doors`. Missing → reject.
- `schema_version` must equal `1`. Unknown version → reject with message "unsupported directive schema_version: <n>".
- `stack_overview` and `project_rules_ref` are optional but recommended for the body renderer.
- `branches` is an array; each entry has required `name`, `findings` (array, possibly empty). `pr_purpose` optional.
- Each finding requires: `severity` ∈ `{P0,P1,P2,P3,P4}`, `confidence` ∈ `[0,100]` integer, `source` ∈ `{COUNCIL, CODEX, "COUNCIL+CODEX"}`, `file` (string), `line` (integer ≥ 1), `rule` (string), `description` (string), `recommendation` (string). Optional fields must be `null` when absent, never missing.
- `trap_doors` entries require all four fields as strings.
- Unknown fields at any level: tolerated (forward compat).

Clean rounds MUST still write a directive JSON with empty `branches[].findings` and empty `trap_doors`.

### Subagent Payload JSON (per-category)

Every subagent returns a final message containing exactly one fenced ```json block of this shape:

```json
{
  "category": "B8_szechuan",
  "branch": "feat/one",
  "status": "ok",
  "skip_reason": null,
  "findings": [ /* same shape as Directive.branches[].findings */ ],
  "trap_door_candidates": [ /* same shape as Directive.trap_doors */ ],
  "codex_per_branch": null
}
```

- `category` is a string; known values are the B1..B9 and C_correctness, C_codex identifiers. Unknown category = reject.
- `branch` is non-null when the subagent is per-branch (C_correctness always; B-categories when tier ≥ l). Stack-wide subagents (B-categories at xs/s/m) set `branch: null`.
- `status`: `"ok"` or `"skipped"`. When `"skipped"`, `skip_reason` must be a non-empty string.
- `codex_per_branch` is populated ONLY by `C_codex`: object keyed by branch name, each value `{verdict: "approve"|"needs-attention"|"failed"|"timeout", reason: string}`.

### Directive renderer output (PR comment body)

The publisher's `composeBody` emits this markdown deterministically from a branch's typed findings + the session's typed trap doors. Never scraped; only generated.

```markdown
## Council of Ricks — Stack Review

_Posted at session end. See the [Council skill](https://github.com/gregorydickson/pickle-rick-claude) for the parallel-round review protocol._

**Session:** `council-<hash>`
**Final round:** 3
**Codex adversarial:** enabled: ran on this branch | disabled: not available

### Findings for this branch

| Severity | Conf | Source | File | Issue | Rule | Recommendation |
|---|---|---|---|---|---|---|
| P0 | 90 | [COUNCIL] | src/auth/session.ts:42 | Missing rotation on refresh | session-security | Force-rotate session id on refresh |

### Trap Doors

- `src/auth/session.ts` — session id must rotate on refresh; reuse window allows hijack; force-rotate on every refresh path

### Round outcomes (this session)

- Round 1: — 4 issues (1/2/1/0/0)
- Round 2: — clean round.
- Round 3: — clean round.
```

No `Branch` column in the published comment (each comment is scoped to one branch — the column was structurally redundant).

---

## Functional Requirements

### FR-1: Directive JSON source of truth

**Scope:** Main agent writes `council-directive.json` atomically every round. Publisher reads it exclusively.

- Path: `<SESSION_ROOT>/council-directive.json`
- Atomic write: `write(path + '.tmp', JSON.stringify(directive, null, 2))` then `fs.rename(path + '.tmp', path)`.
- Clean rounds still write a JSON file with empty `branches[].findings` and empty `trap_doors`, and appropriate `issue_counts: {P0:0, ...}`.
- Markdown directive (`council-directive.md`) is also written for human review but its contents are unconstrained by the publisher.

**Acceptance:**
- `test -f $SESSION_ROOT/council-directive.json` returns 0 after every round.
- `node -e "require('./extension/bin/council-publish.js')"` + a helper reads the file and passes the shape validator.
- Deleting/corrupting the JSON causes the publisher to throw `CouncilPublishError`.

### FR-2: Publisher reads JSON only

**Scope:** Delete all markdown scraping from the publisher.

- `publishCouncilStack(sessionRoot, opts)` reads `council-directive.json`, validates, and throws `CouncilPublishError("council-directive.json missing")` or `CouncilPublishError("council-directive.json invalid: <reason>")`.
- Delete `readLatestDirective`, `findingsForBranch`, `trapDoorsForBranch` from `extension/src/bin/council-publish.ts`.
- `composeBody` takes `{ branch, findings: Finding[], trapDoors: TrapDoor[], codexEnabled, sessionRoot, finalRound, roundOutcomes }` and renders markdown deterministically.
- `extractRoundOutcomes(summaryPath)` unchanged — stays fence-aware, still reads `council-of-ricks-summary.md`.
- `parsePrList` discriminated-result signature unchanged from v1.49.3.

**Acceptance:**
- `grep -r "readLatestDirective\|findingsForBranch\|trapDoorsForBranch" extension/src extension/bin` returns zero matches.
- `grep -r "council-directive\.md" extension/src extension/bin` returns zero matches (except possibly a comment noting it exists for humans only).
- Publisher throws with a clear message when JSON is missing, when it's not valid JSON, when `schema_version !== 1`, and when required fields are missing.

### FR-3: Typed subagent I/O contract

**Scope:** Shape-validated payload from every subagent; fail-loud on drift.

- Shared validator at `extension/src/services/council-schema.ts`:
  - `validateDirective(obj): Directive | never` — throws `CouncilSchemaError` on failure with a `.jsonPath` field identifying the offender.
  - `validateSubagentPayload(obj): SubagentPayload | never` — same pattern.
  - `CouncilSchemaError extends Error` — new error class, exported.
- Main agent's Phase D synthesis:
  - Parse each subagent's fenced ```json block.
  - Call `validateSubagentPayload` on each.
  - On success: merge `findings` and `trap_door_candidates` into the session totals.
  - On failure: record the category as `skipped` with `skip_reason: "schema validation failed: <jsonPath>"` and log the raw payload for debugging. Round demotes to partial per Step 17 rules.
- Per-category schemas (B1..B9, C_correctness, C_codex) are derived from the shared `SubagentPayload` shape plus a `category` string constant; stored in a new session artifact `<SESSION_ROOT>/council-schemas.json` written during Step 6 (setup).

**Acceptance:**
- `council-schema.ts` unit tests exist at `extension/tests/council-schema.test.js` covering:
  - 1 positive case (valid directive; valid subagent payload)
  - ≥ 6 negative cases: missing required top-level field; missing required finding field; wrong severity enum; wrong source enum; confidence out-of-range (−1, 101); extra unknown field tolerated; `schema_version: 2` rejected.
- Validator functions exported from `council-schema.ts`.
- Main agent behavior on schema failure documented in prompt Step 15 / Phase D.

### FR-4: Per-branch B-category sharding for tier ≥ l

**Scope:** Fan-out planner that tier-gates per-branch sharding.

- New pure function in `extension/src/services/council-fanout.ts`:
  ```ts
  function planFanOut(input: {
    stackTier: 'xs' | 's' | 'm' | 'l' | 'xl' | 'xxl',
    branches: string[],         // non-trunk only
    codexEnabled: boolean,
    hasMigrationJournal: boolean
  }): SubagentSpec[]
  ```
  returning the full list of subagent specs for one round, each spec declaring `category`, `branch | null`, and the prompt variables it needs.
- For tier ∈ `{l, xl, xxl}`: one spec per (branch × unconditional B-category). 8 unconditional categories × N branches.
- For tier ∈ `{xs, s, m}`: 8 stack-wide specs (one per unconditional B-category), `branch: null`.
- B7 Migration Hygiene: single spec (stack-wide regardless of tier) iff `hasMigrationJournal`.
- C_correctness: one spec per non-trunk branch regardless of tier.
- C_codex: one spec regardless of tier iff `codexEnabled`.

**Acceptance:**
- `extension/tests/council-fanout.test.js` unit tests:
  - 3-branch stack, tier `s`, codex off, no migration journal → 8 B-specs (`branch: null`) + 3 C_correctness specs + 0 extras. Total 11.
  - 3-branch stack, tier `s`, codex on, has migration journal → 8 + 1 (B7) + 3 + 1 (Codex) = 13.
  - 5-branch stack, tier `xl`, codex on, has migration journal → 5×8 (sharded B) + 1 (B7) + 5 (C_correctness) + 1 (Codex) = 47.
  - 1-branch stack, tier `xxl`, codex off, no journal → 1×8 + 1 + 0 = 9.
- Function is pure (no I/O); takes input, returns array; covered by tests.

### FR-5: Prompt rewrite (`.claude/commands/council-of-ricks.md`)

**Scope:** The command prompt instructs the main agent on the new contracts.

Delete:
- Step 15 step 3 "Required output schema" markdown blob (reference `<SESSION_ROOT>/council-schemas.json` instead)
- Step 16 section 4 "Findings" markdown column rules (column order, backticks, load-bearing language)
- Step 16 section 8 "Publisher-scanned anchors" (no longer relevant — publisher doesn't read the markdown)
- Any language that calls markdown formatting "load-bearing"

Add/modify:
- Step 6 setup: write `council-schemas.json` alongside `council-principles.md`.
- Step 14 Phase B: note that when `stack_tier ∈ {l, xl, xxl}` each B-category subagent runs per-branch; scope its prompt to one branch's diff. Cite the new fan-out planner by name.
- Step 15: fan-out orchestration reads subagent specs from the planner; validates every payload on return; records schema failures as category skips.
- Step 16: "Write `council-directive.json` atomically (tmp + rename) conforming to `council-schemas.json`'s Directive shape. Also write `council-directive.md` as a free-form human summary of the directive JSON — format however you like for readability."
- Persona and approval-gate sections remain unchanged.

**Acceptance:**
- Manual read confirms no markdown formatting rules remain load-bearing.
- `grep -iE 'NO backticks|silent row drop|load.bearing|heading-level contract|column.*load.bearing' .claude/commands/council-of-ricks.md` → zero hits.
- `grep -c 'council-directive\.json' .claude/commands/council-of-ricks.md` ≥ 3 (setup mention, write instruction, publisher input description).

### FR-6: Tests

**Scope:** Port existing publish tests to JSON fixtures; add schema and fan-out tests; delete markdown-scraping-specific regressions.

Delete (because the scrapers are gone):
- Tests asserting backtick normalization in Branch cells
- Tests asserting warning-line-before-JSON tolerance in the publisher's directive-read path (`parsePrList` keeps its own test)
- The cross-contamination test for per-branch H3 tables
- Any fixture containing a `council-directive.md` intended to exercise the scrapers

Keep/port:
- Happy path (posts each branch exactly once) — swap markdown fixture for JSON fixture
- Second run skips already-published branches (idempotency)
- `gh auth fails → all branches skipped_no_gh, bodies still written`
- Empty pr list → `skipped_no_pr`, no marker touched
- Picks OPEN PR over MERGED when both exist
- One pr comment failure does not abort sweep
- Throws when trunk not in branches
- Zero-byte `.published` marker is NOT treated as published
- Throws when repo_path does not exist / not a directory
- Trunk-only stack warns that there is nothing to publish
- Unknown CLI flag → exit 2 (CLI test file)
- `parsePrList`: garbage stdout → classified as `failed`, not `skipped_no_pr`
- `extractRoundOutcomes`: real Step 17 terminal-suffix formats produce round bullets
- `extractRoundOutcomes`: Round headers inside fenced code blocks are not counted

Add:
- `extension/tests/council-schema.test.js` — validator positive + ≥ 6 negative cases (see FR-3)
- `extension/tests/council-fanout.test.js` — planner matrix (see FR-4)
- `extension/tests/council-publish.test.js` — publisher throws when `council-directive.json` missing; throws when invalid JSON; throws when `schema_version !== 1`; throws when required field missing at top level; throws when required field missing inside a finding; renders correct comment body from a minimal valid directive; rendered body contains expected Severity/Rule/Recommendation; rendered body contains Trap Doors block when trap_doors non-empty; rendered body shows "None catalogued." when trap_doors empty.

Registration: add any new test files to `extension/package.json`'s `"scripts.test"` list.

**Acceptance:**
- `node --test tests/council-*.test.js` from `extension/` passes.
- Net test count may drop modestly; that's expected.
- No test reads or writes `council-directive.md` in order to drive publisher behavior.

### FR-7: Version bump, build, release gate

**Scope:** Ship v1.50.0.

- `extension/package.json` version `1.50.0`.
- Rebuild: `npx tsc` from `extension/` — compiled JS in `extension/bin/` updated to match TS.
- Commit everything in one commit: `feat(council-of-ricks): v1.50.0 — JSON directive + per-branch sharding`. No release tag yet — tag is a separate user-driven step.
- Full release gate from `extension/`:
  ```bash
  npx tsc --noEmit && \
  npx eslint src/ --max-warnings=-1 && \
  npx tsc && \
  git diff --exit-code bin/ && \
  node --test tests/council-*.test.js
  ```
  (Skip full `npm test` if the documented `refinement-watcher` flake fires; run all non-watcher tests explicitly.)
- `bash install.sh` from repo root to deploy to `~/.claude/`.

**Acceptance:**
- Each of the gate commands exits 0.
- `git status` is clean after commit.
- Version in `extension/package.json` is exactly `"1.50.0"`.

---

## Trap Doors

1. **Atomic directive write.** Writing `council-directive.json` non-atomically leaves a truncated file if the main agent is killed mid-write. MUST be write-to-`.tmp` + `fs.rename`. Tested.
2. **Schema version field.** `schema_version: 1` reserves room to evolve. Future round that changes the shape must bump and the validator must gate on it. Publisher rejects unknown `schema_version` explicitly; do not silently accept.
3. **Fan-out explosion on xxl.** A 10-branch xxl stack = 10 × 8 = 80 B-subagents + 10 C_correctness + 1 Codex = 91 concurrent Agent tool calls in a single round. Check whether Claude Code's Agent tool has a concurrency ceiling before shipping; if so, the planner must batch within a round (split into waves of e.g. 20) or cap at `max_parallel_agents` from settings.
4. **Shard merge dedupe key.** Two branches legitimately touching the same file at the same line with the same rule is rare but possible. Dedupe by `(branch, file, line, rule, description)`, NOT `(file, line, rule, description)`, so cross-branch findings are kept separately.
5. **Typed payload vs. model quirks.** Subagents sometimes hallucinate extra fields or miss required fields. Validator accepts unknown fields (tolerant forward compat) but rejects missing required fields (strict). Both paths tested in `council-schema.test.js`.
6. **Freshly written JSON and the idempotency marker.** If a previous session wrote `.published/<slug>` markers and the directive JSON changes this session, we still skip those branches. That is correct behavior — `.published` means "we already posted for this session run" and markers are session-scoped (`<SESSION_ROOT>/.published/`). No change needed, but tested.
7. **Codex verdicts in stack_overview.** When Codex is disabled, `codex_verdicts` should be an empty object `{}`, not missing, so the renderer always has a single shape.
8. **Rendered body is "empty but present" on clean rounds.** Clean rounds still publish a comment per branch containing "No findings for this branch at session close." and the trap doors section (possibly "None catalogued."). This matches current behavior; don't silently skip empty findings.

---

## Out of Scope (explicit)

- Concurrent `gh pr comment` in the publisher — deferred, low value.
- Per-Agent-tool-call timeout — deferred.
- Changing `council-publish` CLI arguments.
- Changing approval-gate semantics or promise-tag behavior.
- Changing the session root layout or `mux-runner.js`.

---

## Acceptance Checklist (machine-checkable)

- [ ] `extension/package.json` version === `"1.50.0"`.
- [ ] `grep -r "readLatestDirective\|findingsForBranch\|trapDoorsForBranch" extension/src extension/bin` → zero matches.
- [ ] `grep -r "council-directive\.md" extension/src extension/bin` → zero matches OR only within comments.
- [ ] `grep -iE 'NO backticks|silent row drop|load.bearing|heading-level contract|column.*load.bearing' .claude/commands/council-of-ricks.md` → zero hits.
- [ ] `grep -c 'council-directive\.json' .claude/commands/council-of-ricks.md` ≥ 3.
- [ ] `extension/src/services/council-schema.ts` exists and exports `validateDirective`, `validateSubagentPayload`, `CouncilSchemaError`.
- [ ] `extension/src/services/council-fanout.ts` exists and exports `planFanOut`.
- [ ] `extension/tests/council-schema.test.js` exists with ≥ 7 tests (1 positive + 6 negative).
- [ ] `extension/tests/council-fanout.test.js` exists with ≥ 4 planner matrix tests.
- [ ] Publisher throws `CouncilPublishError` when `council-directive.json` is missing.
- [ ] Publisher throws `CouncilPublishError` when `council-directive.json` has `schema_version` other than `1`.
- [ ] Publisher throws `CouncilPublishError` when a required field is missing.
- [ ] Running the release gate from `extension/` (`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && git diff --exit-code bin/ && node --test tests/council-*.test.js`) exits 0.
- [ ] `git status` shows clean working tree after commit.
- [ ] Commit message matches `feat(council-of-ricks): v1.50.0 — JSON directive + per-branch sharding`.

---

## Rollout

1. Hard cutover. No `--legacy-markdown` flag. Greenfield project.
2. Any in-flight council sessions at upgrade time: their `council-directive.md`-only state will fail `council-publish` → publisher throws → operator restarts the session. Document in v1.50.0 release notes.
3. No on-disk session migration — sessions are short-lived and disposable.
4. After commit, user runs `bash install.sh` from repo root and `gh release create v1.50.0` (release tagging is user-driven, not automated).

---

## Where to start

A fresh agent can execute this PRD in this order, committing atomically at each step:

1. Build the schema validator (`council-schema.ts` + tests). Gate: `node --test tests/council-schema.test.js` green.
2. Build the fan-out planner (`council-fanout.ts` + tests). Gate: `node --test tests/council-fanout.test.js` green.
3. Refactor `council-publish.ts` — swap markdown readers for JSON reader; update `composeBody` to take typed input; delete scrapers. Port publish tests to JSON fixtures. Gate: `node --test tests/council-publish*.test.js` green.
4. Rewrite `council-of-ricks.md` command prompt to match the new contract. Gate: the grep-based acceptance checks above pass.
5. Bump `package.json` to `1.50.0`. Rebuild. Run full release gate.
6. Single commit with the feat message.

Every step ends with a lint+typecheck+tests green state. No step leaves dead code or half-migrated paths behind.
