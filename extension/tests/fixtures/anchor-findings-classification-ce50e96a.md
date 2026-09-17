# B-DRAIN29 ROOT D — anchor findings classification (ticket ce50e96a)

Forensic record for `prds/p1-b-drain29-the-real-anchors-the-repaired-instrument-found.md` ROOT D
(AC-D-2). The repaired citadel trap-door coverage matcher
(`extension/src/services/citadel/trap-door-coverage-audit.ts:runT6TrapDoorCoverage`, compiled at
`extension/services/citadel/trap-door-coverage-audit.js:45`) reports 29 `ENFORCE anchor … not found`
findings across 24 files, enumerated via:

```
node --input-type=module -e "
const m = await import(process.cwd()+'/extension/services/citadel/trap-door-coverage-audit.js');
const r = m.runT6TrapDoorCoverage({projectRoot: process.cwd()});
console.log((r.findings||[]).filter(x => /ENFORCE anchor/.test(x.message)).length);
"
```

Each finding is classified below as one of:
- **STALE** — the test exists; the `ENFORCE:` anchor reference does not literally match its title.
- **MISSING** — no such test exists; the invariant is unguarded.

## Split: 29 STALE / 0 MISSING

This is **not** a rubber-stamp. `hasTestCase` (`trap-door-coverage-audit.ts:237-245`) matches an anchor
only when the **literal, case-sensitive** anchor text is the exact opening token of a quoted `it(`/`test(`
title. Subsystem `CLAUDE.md` files author anchors as slugified, all-lowercase, hyphen-joined text, while
actual test titles preserve natural-language case and punctuation (colons, commas, parentheses, arrows).
Since the matcher does not itself slugify titles before comparing, a slug-form anchor structurally cannot
literal-prefix-match a natural-language title even when it names the exact same test.

Every row below was independently resolved to one specific, unambiguous test in the named file:
- 24 rows resolve by **exact match** once both the anchor and every candidate test title in the file are
  independently normalized (lowercased, non-alphanumeric runs collapsed to `-`) — normalized Levenshtein
  distance 0, and the next-closest candidate title in the same file is far away.
- 5 rows have a partial/ID-only anchor (naming only the ticket-id token, e.g. `AP-EXT-ITER53-01`) or a
  suffix-fragment anchor; each was confirmed via `grep -n` against the named file, which returns exactly
  one matching `it(`/`test(` line — the real title carries an additional prefix or trailing clause the
  anchor omits.

No row among the 29 lacks a plausible resolving test in its named file, and no row was resolved by
proximity guessing — the 5 non-exact rows were each confirmed by reading the actual matching source line
(file:line recorded below). Full resolution methodology: `research_2026-09-17.md` in this ticket's
session directory.

**No `ENFORCE:` clause was deleted and the matcher was not touched to produce this record.**

| # | File | Anchor | Classification | Resolved test (file:line) | Resolved test title |
|---|---|---|---|---|---|
| 1 | extension/tests/release-tag-reconcile.test.js | `ap-ext-iter65-01-the-whole-audit-costs-exactly-one-git-ls-remote-whatever-the-tag-count` | STALE | slug-exact match | `AP-EXT-ITER65-01: the whole audit costs exactly ONE git ls-remote, whatever the tag count` |
| 2 | extension/tests/release-tag-reconcile.test.js | `ap-ext-iter65-01-list-tag-shas-from-listing-is-the-one-place-the-peel-rule-lives` | STALE | slug-exact match | `AP-EXT-ITER65-01: list_tag_shas_from_listing is the ONE place the ^{} peel rule lives` |
| 3 | extension/tests/rrh-rate-limit-park.test.js | `b2-rate-limit-resume-carries-parked-minutes-source-emitter-check` | STALE | slug-exact match | `B2: rate_limit_resume carries parked_minutes (source emitter check)` |
| 4 | extension/tests/rrh-cpu-watchdog.test.js | `wiring-the-cpu-stall-commit-honors-the-ac-2-working-dir-fail-safe-never-process-cwd` | STALE | slug-exact match | `wiring: the CPU-stall commit honors the AC-2 working_dir fail-safe (never process.cwd())` |
| 5 | extension/tests/rrh-rate-limit-park.test.js | `b5-no-reset-at-fall-back-to-now-configured-min-wait-emit-rate-limited-without-reset-at-never-spawn-burn` | STALE | slug-exact match | `B5: no reset_at → fall back to now + configured min_wait + emit rate_limited_without_reset_at (never spawn-burn)` |
| 6 | extension/tests/tsc-gate.test.js | `ap-ext-iter12-01-the-hooks-segmenter-has-one-home-no-private-tsc-gate-copy` | STALE | slug-exact match | `AP-EXT-ITER12-01 the hooks segmenter has ONE home (no private tsc-gate copy)` |
| 7 | extension/tests/tsc-gate.test.js | `ap-ext-iter27-01-the-exec-token-prelude-has-one-home-no-private-tsc-gate-copy` | STALE | slug-exact match | `AP-EXT-ITER27-01 the exec-token prelude has ONE home (no private tsc-gate copy)` |
| 8 | extension/tests/hooks/config-protection-git-boundary.test.js | `ap-ext-iter180-01-no-pin-reads-a-source-file-outside-the-declared-readers` | STALE | slug-exact match | `AP-EXT-ITER180-01 no pin reads a source file outside the declared readers` |
| 9 | extension/tests/mux-runner-fix-b.test.js | `l2-wiring-main-loop-increments-a-recovery-counter-caps-it-and-escalates-to-idle-stall-unrecoverable` | STALE | slug-exact match | `L2: wiring — main loop increments a recovery counter, caps it, and escalates to idle_stall_unrecoverable` |
| 10 | extension/tests/release-gate-parity.test.js | `every-tier-the-test-runner-accepts-is-invoked-by-the-release-gate` | STALE | slug-exact match | `every tier the test runner accepts is invoked by the release gate` |
| 11 | extension/tests/integration/mega-bundle-e2e.test.js | `ap-ext-iter51-01-arm-1-every-covered-spawn-spelling-fires` | STALE | slug-exact match | `AP-EXT-ITER51-01 arm 1: every covered spawn spelling fires` |
| 12 | extension/tests/integration/mega-bundle-e2e.test.js | `ap-ext-iter51-01-arm-2-the-covered-set-is-complete-against-node` | STALE | slug-exact match | `AP-EXT-ITER51-01 arm 2: the covered set is complete against node` |
| 13 | extension/tests/flake-budget.test.js | `flake-budget-ok-verdict-distinguishes-a-single-file-run-from-the-fast-tier` | STALE | slug-exact match | `flake-budget OK verdict distinguishes a single-file run from the fast tier` |
| 14 | extension/tests/post-final-verdict-classifier.test.js | `ap-ext-iter157-02-an-unmeasured-gate-that-exited-non-zero-still-classifies-red-with-dimensions` | STALE | slug-exact match | `AP-EXT-ITER157-02: an unmeasured gate that exited NON-ZERO still classifies red, with dimensions` |
| 15 | extension/tests/release-tag-version-guard.test.js | `guard-step-precedes-the-artifact-build-inside-the-same-job` | STALE | slug-exact match | `guard step precedes the artifact build inside the same job` |
| 16 | extension/tests/install-script.test.js | `install-sh-has-a-dry-run-guard-after-the-lock` | STALE | slug-exact match | `install.sh has a --dry-run guard after the lock` |
| 17 | extension/tests/trap-door-completion-evidence-conformance.test.js | `weakening-the-AUDIT-rule-reaches-this-test` | STALE | line 352 | `AP-EXT-ITER2-01: weakening the AUDIT rule reaches this test — the rule is loaded, not mirrored` |
| 18 | extension/tests/trap-door-conformance.test.js | `ap-ext-iter153-02-a-name-only-a-deletion-assertion-spells-does-not-resolve-as-live-code` | STALE | slug-exact match | `AP-EXT-ITER153-02: a name only a deletion assertion SPELLS does not resolve as live code` |
| 19 | extension/tests/unref-sole-settle-path.test.js | `the-sole-settle-path-scan-is-not-vacuous-it-finds-settling-timers-under-every-root` | STALE | slug-exact match | `the sole-settle-path scan is not vacuous: it finds settling timers under EVERY root` |
| 20 | extension/tests/nostop-gates-invariant.test.js | `a-microverse-phase-with-no-usable-exit-reason-continues-the-second-fail-open-arm` | STALE | slug-exact match | `a microverse phase with no usable exit_reason continues — the second fail-open arm` |
| 21 | extension/tests/jar-runner.test.js | `AP-EXT-ITER53-01` | STALE | line 1121 | `jar-runner: AP-EXT-ITER53-01 task timeout reaps the manager subtree, not just its pid` |
| 22 | extension/tests/b-crsr-resume-counter-seed.test.js | `ap-ext-iter185-01-the-shipped-seed-applies-the-whole-ledger-not-a-chosen-subset` | STALE | slug-exact match | `AP-EXT-ITER185-01: the SHIPPED seed applies the whole ledger, not a chosen subset` |
| 23 | extension/tests/monitor.test.js | `AP-EXT-ITER11-02` | STALE | line 1060 | `R-MDS-4 AC-1 / AP-EXT-ITER11-02: subsystems render consecutive_clean over the clean-pass target, not stall_limit` |
| 24 | extension/tests/eslint-plugin-pickle.test.js | `m3-3-no-rule-less-eslint-disable-directive-exists-anywhere-under-src` | STALE | slug-exact match | `M3-3: no rule-less eslint-disable directive exists anywhere under src/` |
| 25 | extension/tests/integration/gitattr-trailer-producer.test.js | `a-mid-body-Pickle-Ticket-line-does-not-suppress-the-real-trailer` | STALE | grep-confirmed | `gitattr trailer producer — a mid-body Pickle-Ticket line does not suppress the real trailer` |
| 26 | extension/tests/integration/gitattr-trailer-producer.test.js | `a-linked-worktree-still-stamps-the-trailer` | STALE | grep-confirmed | `gitattr trailer producer — a linked worktree still stamps the trailer` |
| 27 | extension/tests/verify-recapture-fired.test.js | `AP-EXT-ITER224-01` | STALE | line 823 | `verify-recapture.orphan-tmp candidacy is a projection of the REQUIRED half of State (AP-EXT-ITER224-01)` |
| 28 | extension/tests/pipeline-runner.test.js | `backend-derives-from-backends-rather-than-being-a-parallel-hand-maintained-union` | STALE | slug-exact match | `Backend derives from BACKENDS rather than being a parallel hand-maintained union` |
| 29 | extension/tests/activity-event-payload.test.js | `activity-event-payload-schema-backendenum-equals-the-backends-const-it-mirrors` | STALE | slug-exact match | `activity-event-payload: schema backendEnum equals the BACKENDS const it mirrors` |
