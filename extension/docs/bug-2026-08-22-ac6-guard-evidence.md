# BUG-2026-08-22 — tier evidence for the AC-6 guard bundle

Ticket `7345074e` (verification). Branch `release/v2.1-beta`, final sha `b9b8bd2f`. Recorded
2026-08-23. Depends on `b94d8693` (`7e206859` extract abort sites by AST symbol identity +
`7dd651ef` collision-fixture code-review fix) and `4508673b` (`b9b8bd2f`, duplicate-detector arm +
two-sha byte-identical equality proof).

Every count below is quoted verbatim from a captured runner summary block or sidecar. Where a
value was not captured, it is recorded as `unmeasured` rather than as `0` or a pass. Measurement
preconditions: Node `v24.19.0` (recorded directly in the `fast` sidecar; the `integration:parallel`
and `integration:serial` sidecars did not capture a `### node:` line — see Section 3 note), all
commands run from `extension/`.

## 0. The bundle's claim

`extension/tests/ac6-operator-surface-guard.test.js` guards four operator/terminal surfaces
(`EXIT_REASONS`, `TERMINAL_ABORT_SITES`, `PICKLE_SETTINGS_KEYS`, `CLI_FLAGS`) against silent
growth by pinning each to a `BASE_INVENTORIES` snapshot taken at base sha `0d7e58dc`. The
`TERMINAL_ABORT_SITES` arm previously extracted abort sites by git-grep + `file:line`, which was
line-number-keyed — any unrelated edit above a tracked abort function shifted its line number and
read as a spurious new site, and the check was blind to `as never` type-assertion casts polluting
the same regex match. This bundle's three commits replace that extractor with a two-step design —
git owns file enumeration (tracked + untracked-but-not-ignored `.ts` under `extension/src`), the
TypeScript AST owns symbol identity (`<file>::<symbolName>`) — so a site's identity survives a line
shift and `as never` casts are structurally excluded. This ticket records durable, auditable tier
evidence for that claim.

## 1. Measurement note — tiers captured by the manager, not this worker

`integration:serial` alone takes ~7.8 minutes; every worker spawn attempting the three-tier
sequence in the foreground was killed mid-run by the 600s foreground ceiling before it could write
anything durable. The manager ran all three tiers directly, with the ambient
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`/`PICKLE_TICKET_ID` environment scrubbed
per prior-session memory `ambient-git-config-false-gate-reds.md` (these vars stamp
`Pickle-Ticket: <this-session's-ticket-id>` into any commit made by test fixtures, corrupting
fixtures that assert against a different ticket id). Captures live under
`<TICKET_DIR>/tier-captures/`: `fast.log`, `integration-parallel.log`, `integration-serial.log`,
each with a `.meta.txt` sidecar. This worker re-reads those captures rather than re-running the
tiers.

## 2. AC-6 guard suite itself: 13/13 pass at HEAD (fast tier, quoted verbatim)

From `tier-captures/fast.log`, lines 20–38:

```
▶ AC-6: Operator/terminal surface guard
  ✔ exit_reason values (EXIT_REASONS enum) (0.915125ms)
  ✔ terminal/abort call sites (functions returning :never) (671.638834ms)
  ✔ pickle_settings.json keys (0.814084ms)
  ✔ CLI parser flags (setup.ts) (1.580792ms)
✔ AC-6: Operator/terminal surface guard (676.036833ms)
▶ AST abort-site extractor: enumeration and identity
  ✔ ignore-aware enumeration: untracked included, gitignored excluded (140.127125ms)
  ✔ collision fails loud: two same-named never-returning functions in one file (104.113459ms)
  ✔ unrecoverable symbol fails loud: unparented never-returning function expression (68.129459ms)
  ✔ function-like gate precedes the .type check: as-never casts are excluded (57.904666ms)
  ✔ 7 known as-never casts at HEAD produce zero abort-site entries (290.506709ms)
  ✔ AC-3: moving a tracked function within its file does not fire the guard (line shift) (143.888417ms)
  ✔ AC-4: adding a real function-like : never declaration fires the guard (126.539ms)
  ✔ AC-4: removing a tracked site fires the removal arm (125.2095ms)
✔ AST abort-site extractor: enumeration and identity (1057.633209ms)
▶ AC-5: two-sha baseline equality proof
  ✔ extractor output at HEAD and at BASE_SHA is byte-identical (set equality) (904.090917ms)
✔ AC-5: two-sha baseline equality proof (904.19ms)
```

4 (`AC-6` describe) + 8 (`AST abort-site extractor` describe) + 1 (`AC-5` describe) = 13 tests,
13/13 pass, 0 fail, run individually within the fast tier's overall pass, matching prior-session
handoff note "AC-6 guard suite itself: 13/13 pass".

### The `as never` trap

`extractAbortSitesFromSource` (`extension/tests/ac6-operator-surface-guard.test.js:193-213`) walks
every function-like node whose return type is the bare `never` keyword. The function-like predicate
(`isFunctionLike = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
ts.isArrowFunction(node) || ts.isFunctionExpression(node)`, line 198) is evaluated and combined with
`&&` **before** the `node.type.kind === ts.SyntaxKind.NeverKeyword` check on the same line — this
ordering matters because a bare `.type.kind === NeverKeyword` test also matches `as never`
`AsExpression` casts, which are not function-like. If the function-like gate were checked after (or
were dropped), the 7 `as never` casts at HEAD (`bin/microverse-runner.ts`, `bin/pipeline-runner.ts`,
`hooks/handlers/tsc-gate.ts`) would leak into the `TERMINAL_ABORT_SITES` extraction as spurious
entries. Two tests pin this directly: `function-like gate precedes the .type check: as-never casts
are excluded` (fixture: one real `never`-returning function plus two `as never` casts in the same
file — asserts exactly `['cast.ts::realAbort']`) and `7 known as-never casts at HEAD produce zero
abort-site entries` (asserts none of the 3 real HEAD files contribute any `<file>::` entry to the
production extraction). Independently confirmed by code review on ticket `b94d8693`: `git grep -n
"as never" -- src/` finds exactly 7 casts across those 3 files, none contributing to the 13-item
baseline.

### AC-5: two-sha byte-identical set equality proof

`materializeShaFixtureRepo(sha)` (`ac6-operator-surface-guard.test.js:570-580`) uses `git archive
<sha> -- extension/src | tar -x` to materialize `extension/src` exactly as it existed at
`BASE_SHA = '0d7e58dc'` into a throwaway fixture repo, then runs the SAME
`extractTerminalAbortSites` function against both HEAD and that materialized base-sha tree. The
test (`AC-5: two-sha baseline equality proof` → `extractor output at HEAD and at BASE_SHA is
byte-identical (set equality)`) asserts `assert.deepStrictEqual(atHead, atBase)` — genuine set
equality between two independently-extracted, sorted arrays, not a hardcoded literal compared
against one live extraction. This replaces the prior dead member-count assertion (a bare
`baseline.length === current.length` cannot distinguish "identical sets" from "one member swapped
for another") with the actual `added`/`removed` diff plus this two-sha extraction, so an
undetected member swap at the same cardinality is now impossible.

## 3. Tier results at `b9b8bd2f`

### fast (`node bin/test-runner.js --tier fast --test-concurrency=8`, scrubbed)

Node `v24.19.0`. Census before: `2026-08-23T00:52:42Z`, `19:52 up 297 days, 5:51, 2 users, load
averages: 1.38 3.43 5.06`. Top CPU consumers before: Google Chrome Framework Helper (Renderer)
17.2%, Google Chrome 8.1%, `claude` 5.8%, Google Chrome Framework Helper (Renderer) 4.8%,
`fontd` 2.5%, `claude` 1.2%. Census after: `19:55 up 297 days, 5:55, 2 users, load averages: 7.51
6.97 6.32` (load rose sharply — a real load-generating fast-tier run, not idle).

```
ℹ tests 7850
ℹ suites 516
ℹ pass 7843
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 1
ℹ duration_ms 170901.712333
```

EXIT=1 (the runner's own process exit code, from the sidecar; matches the 1 real test failure —
report-only, no runner-level halt). The single failure is `tests/install-bun-probe.test.js:20:3`
("bun probe emits banner when bun is absent") — see Section 5, INHERITED/filed, unrelated to this
bundle.

### integration:parallel (`npm run test:integration:parallel`, scrubbed)

Node version: `unmeasured` (this sidecar did not capture a `### node:` line — see Section
preconditions note). Census before: `2026-08-23T00:56:02Z`, `19:56 up 297 days, 5:55, 2 users, load
averages: 6.07 6.67 6.23`. Top CPU consumers before: `claude` 6.7%, `claude` 0.8%, `node` 0.4%,
`airportd` 0.3%, `WindowServer` 0.3%, `tmux` 0.1%. Census after: `19:57 up 297 days, 5:56, 2 users,
load averages: 3.22 5.75 5.93`.

```
ℹ tests 639
ℹ suites 21
ℹ pass 638
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 88946.281292
```

EXIT=1. The single failure is `tests/integration/extension-wiring.test.js:60:1` ("deploy smoke:
gate bins and data exist after bash install.sh"): `Missing deployed paths (run bash install.sh):
/Users/gregorydickson/.claude/agents/morty-gate-remediator.md` — see Section 5, INHERITED/filed, a
`bash install.sh` deployment-freshness gap on this operator box, unrelated to the AC-6 guard.

### integration:serial (`npm run test:integration:serial`, scrubbed)

Node version: `unmeasured` (this sidecar did not capture a `### node:` line — see Section
preconditions note). Census before: `2026-08-23T00:57:38Z`, `19:57 up 297 days, 5:56, 2 users, load
averages: 2.95 5.61 5.87`. Top CPU consumers before: `claude` 6.1%, `claude` 1.0%, `node` 0.5%,
`WindowServer` 0.4%, `wifip2pd` 0.3%, Google Chrome Framework Helper 0.3%. Census after: `20:05 up
297 days, 6:04, 2 users, load averages: 1.85 2.83 4.31`.

```
ℹ tests 608
ℹ suites 24
ℹ pass 608
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 467914.066916
```

EXIT=0. Clean pass, 0 fail, 0 cancelled.

**All three tiers: `cancelled 0`.** Node `v24.19.0` confirmed directly only for the `fast` tier
sidecar; the other two sidecars ran in the same manager-driven sequence immediately after but did
not independently record a `### node:` line, so that specific field is recorded as `unmeasured`
for those two tiers rather than assumed.

## 4. Type check

`npx tsc --noEmit` is not captured under this ticket's `tier-captures/` (that directory holds only
the three test-tier logs). Type-check evidence for the AC-6 guard file is instead traceable to the
two dependency tickets' own conformance docs, both dated 2026-08-22 and both re-verified after
their respective implementation commits landed:

- Ticket `b94d8693` conformance (`conformance_2026-08-22.md`): `cd extension && npx tsc --noEmit` —
  "Exit 0, no output." Re-verified: "Final state re-verified green: 9/9 tests pass, `npx tsc
  --noEmit` exit 0, working tree clean" (at commit `7dd651ef`).
- Ticket `4508673b` conformance (`conformance_2026-08-22.md`): "`npx tsc --noEmit` — exit 0, no
  errors" and "Test runner passes — all acceptance tests (13/13 in the target file...)".

No independent `npx tsc --noEmit` run against the current HEAD (`b9b8bd2f`) is captured under this
ticket; this section cites the dependency tickets' own captured runs rather than asserting a fresh
pass.

## 5. AC disposition

| AC | Requirement | Result |
|---|---|---|
| Evidence doc records before/after AC-6 verdict + two-sha equality | met — Section 0/2, byte-identical set equality between HEAD and base sha `0d7e58dc` |
| All three tiers recorded with census and load average | met — Section 3, all three tiers have census before/after and load averages; Node version recorded for `fast` only, marked `unmeasured` for the other two rather than assumed |
| The `as never` trap is recorded so it is not reintroduced | met — Section 2, function-like-before-`.type` ordering documented with the two pinning tests |
| Remaining failures named and attributed as the two filed inherited ones | met — Section 6 |

## 6. Attribution — the two remaining tier-level reds predate/are outside this bundle

- `tests/install-bun-probe.test.js` (fast tier) — pre-existing environmental flake, already recorded
  identically failing in prior evidence docs (`extension/docs/bug-2026-08-20-trailer-normalization-evidence.md`,
  Section 6, itself citing `bug-2026-08-19-tier-evidence.md`). INHERITED, filed.
- `tests/integration/extension-wiring.test.js` (integration:parallel tier) — `bash install.sh`
  deployment-freshness gap on this operator box (missing deployed
  `~/.claude/agents/morty-gate-remediator.md`), unrelated to the AC-6 guard's abort-site extractor.
  INHERITED, filed, recorded here as an out-of-scope failure for this bundle, not a bundle failure.

**Disposition: the bundle's thesis holds.** The AC-6 guard suite is 13/13 pass at HEAD, the two-sha
extraction proves byte-identical set equality between HEAD and the pre-fix baseline sha, the `as
never` trap ordering is pinned by two dedicated tests, all three tiers report `cancelled 0`, and the
only two remaining tier-level reds are both the same pre-existing inherited failures recorded in
this repo's prior evidence docs — reported honestly here rather than omitted, per this repo's PRIME
DIRECTIVE (report degradation, do not halt, do not silently convert a red into a pass).
