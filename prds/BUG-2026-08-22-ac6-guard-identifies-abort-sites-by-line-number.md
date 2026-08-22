# BUG-2026-08-22 (P2) — the AC-6 operator-surface guard identifies abort sites by LINE NUMBER

*(refined: requirements / codebase / risk-scope analysts, 3 cycles, session `2026-08-22-b2ecaea6`)*

## Status

Open. Branch `release/v2.1-beta`. **This bundle blocks the release** — `AC-6` is the only non-inherited
red in an otherwise-green full gate (tsc/eslint/build/9 audits RC=0; integration:serial and
test:expensive RC=0).

## What happens (unchanged, verified)

`TERMINAL_ABORT_SITES` in `extension/tests/ac6-operator-surface-guard.test.js` records members as
**`file:line`** and compares by string membership. Any edit that shifts a tracked function's line
number reads as a newly-added abort site.

Measured: `main(): never` sat at `test-runner.ts:298` at base sha `0d7e58dc` and at `:312` after
`313baa68` added a helper and an import above it. The file's `: never` inventory is **unchanged**.

## 🚨 Refinement FALSIFIED the proposed remedy — read this before implementing

*(refined: codebase built and ran it; risk-scope independently measured the same)*

The authored fix said "identify by enclosing **symbol name**". The obvious implementation is defective:

**A predicate of `node.type.kind === ts.SyntaxKind.NeverKeyword` yields 20 nodes, not 13.** Seven are
`AsExpression` casts (`'tsc_gate_crashed' as never`), because an `as never` cast's `.type` is *also* a
`NeverKeyword`. Measured phantom sites: `hooks/handlers/tsc-gate.ts:327,343,359,445,446`,
`bin/microverse-runner.ts:4051`, `bin/pipeline-runner.ts:4493`. `as never` appears **15 times across 8
files**, is invisible to the shipped `git grep "): never"` extractor, and **MUST stay invisible**.

**Pasted literally, the authored AC would have made the guard redder than the bug it fixes.**

Worse, two draft ACs were **mutually unsatisfiable**: one mandated the predicate above, another mandated
*"the new baseline MUST contain exactly 13 entries; fewer is a FAILURE."* The resolution an implementer
reaches under gate pressure — re-pin at whatever is green — **permanently enters 7 non-abort-sites into
the guard**, laundering the defect into the baseline. That failure mode is the reason AC-5 below is an
equality proof rather than a cardinality check.

**The `git grep` vs filesystem-walk dispute was a false choice** *(refined: requirements ran the
deciding experiment)*. Scan **enumeration** and symbol **identity** are orthogonal, and all three
analysts plus the authored PRD collapsed them into one. **Git must own enumeration** — it is the only
thing that knows the ignore rules; a naive filesystem walk surfaces a gitignored generated file. **The
TS AST must own identity.** The hybrid was built and measured: **exactly 13 sites, 0 collisions,
295 ms**, catching untracked files and multi-line signatures while correctly excluding the gitignored
contaminant. Risk-scope **observed the scan root mutate mid-measurement**, with the contaminant
invisible to `git status` — this is not a hypothetical.

## Acceptance criteria

- **AC-1** Every tracked abort site is identified as `<file>::<symbolName>`, derived from a **TypeScript
  AST walk** over the enumerated `.ts` files. Parse with
  `ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true)` — **the 4th
  argument MUST be `true`**, or `node.parent` is undefined and `bin/init-microverse.ts::fail` (an
  `ArrowFunction` named via its parent `VariableDeclaration`) cannot be resolved.
  A node is an abort site **ONLY IF** it is function-like — `ts.isFunctionDeclaration`,
  `ts.isMethodDeclaration`, `ts.isArrowFunction`, `ts.isFunctionExpression` — **AND** its `.type` is
  `ts.SyntaxKind.NeverKeyword`. **The function-like test MUST come first**; testing `.type` alone also
  matches `AsExpression` and adds the 7 phantom sites listed above.
  Restrict the walk to `.ts`: the scan root also holds 4 `CLAUDE.md` and 5 `.json` files, and
  `src/bin/CLAUDE.md` contains `as never` in prose. Comments are not AST nodes, so
  `bin/mux-runner.ts:723` (prose containing `): never`) is structurally excluded — **verified absent
  from the AST output** — and **no comment-stripping rule is needed on this path**.
  Precedent: `src/services/citadel/frontend-prop-drift-audit.ts` is the only in-repo `typescript`
  consumer; `typescript@5.9.3` resolves and runs from `extension/`.
- **AC-1b** The extractor MUST NOT dedupe and MUST NOT drop. A repeated identity fails with
  `collision: <file>::<symbol> appears N times`; a function-like `never` declaration with no recoverable
  name fails with `unrecoverable symbol at <file>:<line>`. **Both are zero today** — measured 0
  collisions and 0 unnamed at HEAD and at `0d7e58dc` — so these are **forward guards, not outstanding
  defects**. Do not dedupe: the existing count assertion (`:258-262`) is dead code under `file:line` and
  would otherwise become the only collision detector, failing with a bare `member count mismatch` naming
  no symbol.
- **AC-2** Enumeration is **git-owned and ignore-aware** (untracked files included, gitignored files
  excluded). Identity is **AST-owned**. The two are separate steps; do not collapse them.
- **AC-3** Moving a tracked function within its file does NOT fire the guard. Pin with a test that
  shifts a function's line number and asserts the guard stays green.
- **AC-4** Adding a genuinely new function-like declaration returning `: never` DOES fire the guard;
  removing a tracked site still fires the existing removal arm (mutation detection preserved, not traded
  away for AC-3). Renaming is reported as `removed X` + `added Y`, never silently accepted.
- **AC-5 (anti-laundering, equality not cardinality)** The extractor yields the **byte-identical** set at
  HEAD and at base sha `0d7e58dc` — measured: **13 named sites, 0 unnamed, 0 collisions at both**. Assert
  set equality across the two shas, NOT "exactly 13". A cardinality clause invites re-pinning at whatever
  is green, which is exactly how the 7 phantom sites would enter the baseline permanently.
- **AC-6** The baseline is re-pinned once at the new identity scheme and `BASE_SHA` updated, so the first
  run after the fix is green without hand-editing entries.
- **AC-7** No new `exit_reason`, no new abort condition, no new halt path (PRIME DIRECTIVE). Note the
  irony budget: this bundle edits the guard that enforces this rule — it must not add a site to itself.
- **AC-8 (report-only, non-gating)** Tiers do not regress: `cancelled 0`, and the only remaining failures
  are the two filed inherited ones (`install-bun-probe`, `extension-wiring` deploy smoke). `AC-6:
  Operator/terminal surface guard` goes **green** — that transition is this bundle's thesis.

## Verification Strategy

Node 24 + pnpm on PATH; censused idle box recording load average and top CPU consumers by name.

```bash
cd extension
node --test tests/ac6-operator-surface-guard.test.js     # MUST be 4/4
node bin/test-runner.js --tier fast --test-concurrency=8 # AC-6 green; only bun-probe remains
npx tsc --noEmit && npx eslint src/ --max-warnings=-1
# AC-5 two-sha equality proof: run the extractor at HEAD and at 0d7e58dc, diff the sorted output
```

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-1 | `tests/ac6-operator-surface-guard.test.js` | AST walk, function-like test first | 13 named sites; the 7 `as never` casts absent |
| AC-1b | same | no dedupe / no drop | collision and unrecoverable-symbol both fail loud; 0 of each today |
| AC-3 | new | shift a tracked function's line | guard stays green |
| AC-4 | new | add a real `: never` function | guard fires |
| AC-5 | new | extractor output at HEAD vs `0d7e58dc` | sets byte-identical |

## Non-goals

- Widening the guard to ignore additions.
- Re-baselining `file:line` entries as a workaround — buys one green run, re-breaks on the next edit.
- A comment-stripping pass on this path: comments are not AST nodes, verified. *(The repo does already
  export comment-stripping helpers — noted so nobody writes a third copy for a different path.)*
- The other inventories in the suite (`pickle_settings.json` keys, CLI parser flags) unless they share
  the positional-identity defect; check and state the finding either way.

## Execution posture

**UNATTENDED.** Test-and-guard surface only; no salvage / completion-evidence / Done-flip path touched.

## Simplification Review

1. **Necessary?** No new machinery — a change of identity key plus an ignore-aware enumeration step.
2. **Reuse?** `typescript` is already a resolved dependency with an in-repo consumer
   (`frontend-prop-drift-audit.ts`); git already owns ignore rules. Both reused, nothing invented. The
   exported comment-stripping helpers are deliberately NOT used — the AST makes them unnecessary here.
3. **Guards brittle complexity?** It IS the brittle thing. Correct the identity key; do not add an
   allowlist of "expected line shifts" beside it — that is a second hatch for one guard.
4. **Subtracts?** A whole class of false positives, the override habit they train on the repo's most
   load-bearing invariant, and the dead count assertion at `:258-262`.
