---
title: P2 bug-fix bundle — B-GATE — verify-command safety (host-tool preflight + zsh shell-glob safety)
status: Draft
filed: 2026-05-31
priority: P2
type: bug-bundle
code: B-GATE
composes:
  - "#39 R-PVTA — verification commands use rg/fd/bat/jq without host-tool check → silent worker failures (missing tool ENOENT/`command not found` misread as the check failing or passing)"
  - "#40 R-VSGE — verification commands with shell-special chars error or mis-expand under zsh/sh glob expansion when run with shell:true"
backend_constraint: any
schema_neutral: true   # no state.json field, no LATEST_SCHEMA_VERSION change, does NOT touch the #74 schema-bump machinery
source:
  - prds/MASTER_PLAN.md   # Open Findings #39 R-PVTA, #40 R-VSGE
---

# B-GATE — verify-command safety

## Trigger

Two compounding hazards in how acceptance-criteria / verify commands are executed by the AC phase gate (and, for the host-tool hazard, the convergence gate):

- **#39 R-PVTA (host-tool):** A ticket's machine-checkable AC command (or a convergence-gate check command) invokes a modern CLI tool — `rg`, `fd`, `bat`, `jq`, `delta`, etc. — that is **not guaranteed present** on the host. When the tool is absent the command either fails with `ENOENT` (argv form) or exits non-zero with `command not found` (shell form). Both surface as the *criterion* failing (or, on some shells, a `0` exit that misreads as passing), so the operator sees a spurious gate FAIL/PASS attributed to the ticket rather than the missing dependency.
- **#40 R-VSGE (zsh glob):** A string-form AC command containing unquoted glob/special chars (`*`, `?`, `[...]`, `{...}`) is run through a shell. Under the host's `/bin/sh` (and especially when a user's shell is zsh with `no_nomatch` off behavior emulated) an unmatched glob errors out or mis-expands, producing a spurious non-zero exit unrelated to the assertion the AC was meant to make.

Both produce **misattributed gate outcomes**: a green check looks red, or a missing dependency looks like broken code. The fix surfaces a clear, actionable signal ("tool X not installed", "unquoted glob hazard in AC <id>") and runs the command glob-safely, instead of letting the misattribution propagate.

## Root cause (verified 2026-05-31 against the code)

The single hot execution site for ticket AC commands is `runCriterion` in the AC phase gate:

1. **R-VSGE — string-form AC commands run under a shell.** `extension/src/services/ac-phase-gate.ts:134-136`:
   ```
   const result = Array.isArray(criterion.command)
     ? spawnSync(criterion.command[0], criterion.command.slice(1), { cwd: commandCwd, encoding: 'utf-8', timeout })
     : spawnSync(criterion.command, { cwd: commandCwd, encoding: 'utf-8', shell: true, timeout });
   ```
   The **string** branch passes `shell: true` (Node's default shell — `/bin/sh` on POSIX), so any unquoted glob/special char in the command is subject to shell glob expansion. The **array** branch (line 135) already bypasses the shell and is glob-safe. There is no quoting, no `noglob`, and no lint of the manifest command for glob hazards anywhere on this path.

2. **R-PVTA — no host-tool availability check on either execution path.** In the same `runCriterion` (`ac-phase-gate.ts:127-146`), a missing binary collapses into the generic failure classifier: `if (result.error) return { id, reason: safeErrorMessage(result.error) }` (line 137-139) for the argv form (ENOENT → opaque "spawnSync ... ENOENT"), and for the shell form the missing tool produces a non-zero `result.status` that is reported as `expected exit N, got 127: <detail>` (line 140-144). Neither path distinguishes "the tool the AC relies on is not installed" from "the assertion the AC makes is false". `safeErrorMessage` is `extension/src/services/pickle-utils.ts:109`. No `command -v` / `which` / availability probe exists in `ac-phase-gate.ts` (grep confirms zero matches).

3. **R-PVTA secondary site — convergence-gate check commands split-and-exec without a tool check.** `runCheckCommand` (`extension/src/services/convergence-gate.ts:462-506`) does `cmd.split(' ')` then `execFile(bin, args, …)` — **no shell** (so R-VSGE does not apply here), but a missing `bin` returns `err.code` (ENOENT) that `buildFailures` then classifies off the non-zero exit. The convergence-gate `cmdMap` commands are project-type defaults (`convergence-defaults.ts`), but operator/PRD-supplied check commands flow through the same leaf, so the host-tool hazard is shared. This bundle adds the preflight detection helper and wires it at the AC-gate site (the ticket-authored surface); the convergence-gate wiring is covered by R-PVTA-2's reuse of the shared helper at the `runCheckCommand` entry.

The manifest itself is authored upstream (`spawn-refinement-team.ts`, `pipeline-runner.ts:2839`, `finalize-gate.ts` all reference `runAcPhaseGate` / `AC_PHASE_MANIFEST`), but the **execution** misattribution is entirely local to the two leaves above — that is where the fix lands.

## Scope / version

- **Version: PATCH** (1.89.1 → 1.89.2). Schema-neutral: no `state.json` field, no `LATEST_SCHEMA_VERSION` change, no new activity event required (failures stay in the existing `AcPhaseGateFailure.reason` channel with a clearer prefix; the convergence-gate path reuses existing `GateCheck` failure shapes). Does NOT touch the #74 schema-bump machinery.
- The fix is **detection + glob-safe execution + clear-signal reporting** — it MUST NOT change a genuinely-failing AC into a pass, and MUST NOT change a genuinely-passing AC into a fail. The default-deny posture is preserved: a real assertion failure still fails.

## In scope

- A reusable host-tool detection/lint helper that classifies an AC/verify command string for (a) reliance on non-guaranteed CLI tools and (b) unquoted glob hazards.
- Wiring that helper into `runCriterion` (`ac-phase-gate.ts`) so a missing-tool failure is reported as `tool 'X' not installed` (distinct, actionable) and string-form commands run glob-safely.
- Reuse of the host-tool detection at the convergence-gate `runCheckCommand` leaf so a missing `bin` reports `tool 'X' not installed` rather than an opaque ENOENT.
- Regression tests + a forward-protection lint/audit + a trap-door pin.

## Not in scope

- Rewriting AC manifest authoring (`spawn-refinement-team.ts` prompt) to *forbid* modern tools — authors may still use `jq` etc.; the gate surfaces the missing-tool signal at run time. (A future authoring-lint is a separate follow-up.)
- Installing tools on the host or vendoring `rg`/`jq` — out of our control; we surface the signal.
- Changing the convergence-gate project-type default commands (`convergence-defaults.ts`) — those are POSIX-standard already.
- Any change to `expected_exit_code` semantics or the timeout contract (R-AC trap door: finite positive timeout stays).

## Atomic tickets

### R-PVTA-1 (medium) — Host-tool detection helper (forward-created)
- Create `extension/src/services/verify-command-safety.ts` (forward-created) exporting:
  - `NON_GUARANTEED_TOOLS: ReadonlySet<string>` — the curated set `{ rg, fd, fdfind, bat, jq, delta, exa, eza, ag, sd, dust, duf, hyperfine, http, xh }`.
  - `detectMissingTools(command: string | string[], opts?: { which?: (bin: string) => boolean }): string[]` — extracts the leading command word(s) (for shell-form, the first word of the command and of each `|`/`&&`/`;`-separated segment; for argv-form, `command[0]`), intersects with `NON_GUARANTEED_TOOLS`, and returns those whose binary is NOT resolvable on `PATH`. Default resolver is a `spawnSync('command', ['-v', bin])`-free pure-`PATH`-scan (walk `process.env.PATH`, `fs.existsSync` + executable bit) so it adds no subprocess and is testable via the injectable `which` seam.
- **AC (machine-checkable):**
  - `git ls-files extension/src/services/verify-command-safety.ts` returns the path (file exists after this ticket).
  - `grep -c "export const NON_GUARANTEED_TOOLS" extension/src/services/verify-command-safety.ts` ≥ 1 AND `grep -c "export function detectMissingTools" extension/src/services/verify-command-safety.ts` ≥ 1.
  - `node --test extension/tests/services/verify-command-safety.test.js` (forward-created by ticket R-PVTA-3) exits 0.

### R-PVTA-2 (medium) — Wire missing-tool detection into the execution leaves
- In `runCriterion` (`extension/src/services/ac-phase-gate.ts:127-146`), BEFORE the `spawnSync` call, run `detectMissingTools(criterion.command)`; when it returns a non-empty list, short-circuit and return `{ id: criterion.id, reason: \`tool not installed: ${missing.join(', ')} — install the tool or rewrite the AC with POSIX equivalents\` }` instead of spawning. When the list is empty, proceed exactly as today.
- In `runCheckCommand` (`extension/src/services/convergence-gate.ts:462-506`), after the `cmd.split(' ')` → `bin` resolution and BEFORE `execFile`, apply the same `detectMissingTools([bin])` check; when `bin` is non-guaranteed and unresolvable, resolve the `CheckResult` with a `tool not installed: <bin>` stderr and the existing non-zero `exitCode` shape so `buildFailures` surfaces the clear reason (no new failure type).
- Rebuild deployed `extension/services/ac-phase-gate.js` + `extension/services/convergence-gate.js` (deploy parity).
- **AC (machine-checkable):**
  - `grep -c "detectMissingTools" extension/src/services/ac-phase-gate.ts` ≥ 1 AND `grep -c "detectMissingTools" extension/src/services/convergence-gate.ts` ≥ 1.
  - `grep -c "tool not installed" extension/src/services/ac-phase-gate.ts` ≥ 1.
  - `node --test extension/tests/services/ac-phase-gate-tool-preflight.test.js` (forward-created by ticket R-PVTA-3) exits 0: a criterion whose `command` is `["jq", ".x", "f.json"]` with an injected `which` that reports `jq` absent yields a failure whose `reason` matches `/tool not installed: jq/`; the same criterion with `which` reporting `jq` present spawns normally.

### R-PVTA-3 (small) — Regression tests for the host-tool path
- Create `extension/tests/services/verify-command-safety.test.js` (forward-created) covering `detectMissingTools`: argv-form, shell-form with pipes/`&&`/`;`, present vs absent via the injected `which` seam, and that a POSIX-standard tool (`grep`, `test`, `git`) is NEVER flagged even when absent (it is not in `NON_GUARANTEED_TOOLS`).
- Create `extension/tests/services/ac-phase-gate-tool-preflight.test.js` (forward-created) asserting the R-PVTA-2 AC-gate behavior end-to-end through `runAcPhaseGate` with a fixture manifest.
- Register both in the correct tier (default `@tier: fast` via `node --test` discovery; no subprocess-heavy spawn → no `.serial-tests.json` entry needed).
- **AC (machine-checkable):**
  - `git ls-files extension/tests/services/verify-command-safety.test.js extension/tests/services/ac-phase-gate-tool-preflight.test.js` returns BOTH paths.
  - `node --test extension/tests/services/verify-command-safety.test.js extension/tests/services/ac-phase-gate-tool-preflight.test.js` exits 0.
  - `bash scripts/audit-test-tiers.sh` exits 0.

### R-VSGE-1 (medium) — Glob-safe execution of string-form AC commands
- In `runCriterion` (`extension/src/services/ac-phase-gate.ts:134-136`), make the string-form `spawnSync` glob-safe. Either (a) prefer the **argv path** — if the string contains no shell metacharacters that *require* a shell (no `|`, `&&`, `||`, `;`, `<`, `>`, `$`, backtick, subshell), tokenize and run via the argv `spawnSync(bin, args, { timeout })` (no `shell`), so `*`/`?`/`[...]`/`{...}` are passed literally; OR (b) when a shell is genuinely required, run under a glob-disabled shell invocation (`spawnSync('/bin/sh', ['-c', 'set -f; ' + command], …)` — `set -f` disables filename globbing). Pick one mechanism and document it; the array-form branch (line 135) is already glob-safe and stays unchanged.
- Add `containsUnquotedGlobHazard(command: string): boolean` to `extension/src/services/verify-command-safety.ts` (created by ticket R-PVTA-1) — true when the command has an unquoted `*`, `?`, `[...]`, or `{...}` outside single/double quotes. Used by the lint in R-VSGE-2 and to choose the execution path.
- Rebuild deployed `extension/services/ac-phase-gate.js` + `extension/services/verify-command-safety.js`.
- **AC (machine-checkable):**
  - `grep -Ec "set -f|spawnSync\\(bin, args" extension/src/services/ac-phase-gate.ts` ≥ 1 (the chosen glob-safe path is present) AND `grep -c "shell: true" extension/src/services/ac-phase-gate.ts` == 0 (the unguarded `shell: true` string branch is gone).
  - `grep -c "export function containsUnquotedGlobHazard" extension/src/services/verify-command-safety.ts` ≥ 1.
  - `node --test extension/tests/services/ac-phase-gate-glob-safety.test.js` (forward-created by ticket R-VSGE-3) exits 0.

### R-VSGE-2 (small) — Forward-protection lint for unquoted glob hazards in AC commands
- Add `extension/scripts/audit-ac-command-glob-safety.sh` (forward-created): scans the AC-gate source to assert no `shell: true` is reintroduced on the criterion-command path, and provides a `--lint <manifest.json>` mode that WARNs (exit 0 with stderr) on any criterion whose string `command` trips `containsUnquotedGlobHazard` so authors get a heads-up. Delegate the hazard predicate to `extension/services/verify-command-safety.js` (created by ticket R-PVTA-1) via a Node one-liner — NO inline regex copy in the shell script (parity with the R-FRA-2 single-source pattern).
- **AC (machine-checkable):**
  - `git ls-files extension/scripts/audit-ac-command-glob-safety.sh` returns the path AND `test -x extension/scripts/audit-ac-command-glob-safety.sh` (executable bit set).
  - `bash extension/scripts/audit-ac-command-glob-safety.sh` exits 0 on the fixed tree.
  - `grep -c "verify-command-safety" extension/scripts/audit-ac-command-glob-safety.sh` ≥ 1 AND `grep -Ec "containsUnquotedGlobHazard\\s*=\\s*/" extension/scripts/audit-ac-command-glob-safety.sh` == 0 (no inline regex copy).

### R-VSGE-3 (small) — Regression tests for glob safety
- Create `extension/tests/services/ac-phase-gate-glob-safety.test.js` (forward-created): a criterion whose `command` is a string containing an unmatched glob (e.g. `test -n "$(echo extension/src/*.nonexistent-glob)"` or a literal-arg case) runs without a spurious shell glob-expansion error — the criterion's exit reflects the assertion, not the shell. Include a positive case proving `containsUnquotedGlobHazard` flags `cat extension/src/*.ts` and does NOT flag `cat 'extension/src/*.ts'` (quoted) or `grep -n foo file.ts` (no glob).
- Register in the correct tier (default `@tier: fast`).
- **AC (machine-checkable):**
  - `git ls-files extension/tests/services/ac-phase-gate-glob-safety.test.js` returns the path.
  - `node --test extension/tests/services/ac-phase-gate-glob-safety.test.js` exits 0.
  - `bash scripts/audit-test-tiers.sh` exits 0.

### R-GATE-TD (small) — Trap-door pins
- Pin both invariants in `extension/src/services/CLAUDE.md` `## Trap Doors`:
  - `ac-phase-gate.ts` (R-PVTA host-tool preflight) — INVARIANT: `runCriterion` calls `detectMissingTools(criterion.command)` BEFORE `spawnSync` and short-circuits with a `tool not installed: <X>` reason for absent non-guaranteed tools. ENFORCE: `extension/tests/services/ac-phase-gate-tool-preflight.test.js`. PATTERN_SHAPE: `detectMissingTools(` before any `spawnSync(` in `runCriterion`.
  - `ac-phase-gate.ts` (R-VSGE glob safety) — INVARIANT: the string-form criterion command never runs with bare `shell: true`; it runs argv-form or under `set -f`. BREAKS: reintroducing `shell: true` on the criterion path re-opens spurious glob-expansion failures. ENFORCE: `extension/tests/services/ac-phase-gate-glob-safety.test.js`, `extension/scripts/audit-ac-command-glob-safety.sh`. PATTERN_SHAPE: `shell: true` absent from the criterion-command branch.
  - `verify-command-safety.ts` (R-PVTA/R-VSGE shared predicate) — INVARIANT: `NON_GUARANTEED_TOOLS`, `detectMissingTools`, `containsUnquotedGlobHazard` are defined ONLY here; `ac-phase-gate.ts`, `convergence-gate.ts`, and `audit-ac-command-glob-safety.sh` import from it. ENFORCE: `extension/tests/services/verify-command-safety.test.js`.
- Also add the `ac-phase-gate.ts` host-tool/glob pins to the matching `## Trap Doors` block in `extension/CLAUDE.md` if that is where the AC-gate trap door currently lives (the existing `src/services/ac-phase-gate.ts` finite-timeout pin is in `extension/CLAUDE.md`).
- **AC (machine-checkable):**
  - `bash scripts/audit-trap-door-enforcement.sh` exits 0 with the new pins.
  - `grep -c "R-PVTA" extension/src/services/CLAUDE.md` ≥ 1 AND `grep -c "R-VSGE" extension/src/services/CLAUDE.md` ≥ 1.
  - Every ENFORCE test file named in the new pins exists (`git ls-files` returns each).

### C-GATE-CLOSER [manager] — Ship B-GATE
- Run the FULL release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Confirm GREEN before any bump.
- Bump `extension/package.json` to **1.89.2** (PATCH — schema-neutral, no new event/flag/state-field), commit `chore(C-GATE-CLOSER): ship B-GATE — bump 1.89.2 + repoint MASTER_PLAN`.
- `bash install.sh`, verify clean tree + deployed JS matches source (`extension/services/ac-phase-gate.js`, `extension/services/convergence-gate.js`, `extension/services/verify-command-safety.js`), `git push`, `gh release create v1.89.2`.
- Mark MASTER_PLAN B-GATE SHIPPED (drain-queue row 5 removed, Status version updated), close findings #39 R-PVTA and #40 R-VSGE.

## Acceptance (bundle-level)

- An AC command relying on an absent non-guaranteed tool fails with `tool not installed: <X>` — not an opaque ENOENT or a misattributed assertion failure (R-PVTA-1, R-PVTA-2).
- The same missing-tool signal surfaces at the convergence-gate check leaf (R-PVTA-2).
- A string-form AC command with an unmatched glob runs without a spurious shell glob-expansion failure; the criterion's exit reflects the assertion (R-VSGE-1).
- A forward-protection lint blocks reintroduction of bare `shell: true` on the criterion path and warns on glob-hazard AC strings (R-VSGE-2).
- POSIX-standard tools (`grep`, `test`, `git`, …) are never flagged as missing (R-PVTA-3 negative cases).
- Trap doors pinned; `audit-trap-door-enforcement.sh` green (R-GATE-TD).
- Release gate green, clean tree, shipped through `gh release create v1.89.2`, findings #39 + #40 closed (C-GATE-CLOSER).
