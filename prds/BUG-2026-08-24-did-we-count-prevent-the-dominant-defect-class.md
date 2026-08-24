> **✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — 2026-08-24 at HEAD `ec5c5272`.**
>
> **Stale premise: PASSED**, four spot-checks against the MECHANISMS, not R-codes:
> 1. `extension/scripts/audit-trap-door-enforcement.sh` exists, 19 `ENFORCE` references — the mechanism
>    AC-3 extends is live.
> 2. `gate/baseline.json` keys measured: `captured_at, captured_iteration, checks, failures,
>    project_type, schema_version, working_dir` — **no per-check ran/skipped/status field**. AC-5's
>    premise holds exactly.
> 3. Reuse hosts confirmed: `eslint-plugin-pickle/` + `eslint.config.js` + `ESLINT_RULES.md`, and 16
>    `audit-*.sh` scripts (9 gate-wired).
> 4. **18 of 18 corpus shas are reachable** — so AC-1 is executable, not aspirational.
>
> **Green tree: PASSED, baseline recorded.** `npm run test:fast`, node 24.19.0 pinned:
> **pass 7961 / fail 1 / cancelled 0 / 177.8s**. The one failure is the inherited `install-bun-probe`
> P3. Recorded as inherited; any OTHER fast-tier failure during this bundle is caused by this bundle.
>
> **Note on this bundle specifically:** AC-4 requires reporting a raw whole-tree hit count. Expect the
> first honest number to be uncomfortable. Narrowing to the corpus is the correct response; shipping a
> noisy rule is not.

# BUG-2026-08-24 (P1) — stop DISCOVERING the did-we-count defect class; start PREVENTING it

- **Priority**: P1 — operator-set 2026-08-24, sequenced **AHEAD of the remaining P1 bug queue**.
- **Status**: Open. Authored from a measured corpus, not from theory.
- **Type**: bug-bundle (preventive / subtractive)
- **Operator directive**: *"we have to get quality up"* — the answer is to convert a recurring discovery
  into a single prevention.

## Trigger

Two consecutive bundles (`v2.1.0-beta.13`, `v2.1.0-beta.14`) produced **~25 review-phase commits, of
which 18 are one pattern**: a failed, skipped, or truncated operation read as a measured result.
`prds/MASTER_PLAN.md` already names this the codebase's dominant defect class and had catalogued 10
prior instances. Fixing them one at a time is treading water by construction — the review phases will
keep finding them for as long as nothing prevents them.

## The measured corpus (this is the specification — do not generalize beyond it)

**Process identity — a pid/handle treated as an identity or a leaf:**
| sha | finding |
|---|---|
| `697fd734` | never group-kill the process group the reaper itself runs in |
| `39c5b33e` | a registry pid is a slot, not an identity; pin to (pid, start-time) |
| `2c857117` | a pidfile pid is a slot, not an identity |
| `ff8d4739` | a jar manager is a subtree ROOT — reap its GROUP, not its pid |
| `41b9b255` | the LLM judge is a subtree ROOT too |
| `4b0a4a70` | a gate check is a subtree ROOT, and `execFile` **silently drops** `detached` |

**Capture / enumeration — a truncated or failed read reported as complete:**
| sha | finding |
|---|---|
| `7e06e8b2` | an uncapped capture buffer is a **fake-RED gate verdict**, not a truncated log |
| `e2804228` | an arbitrary plan-phase verify command is the widest capture in the file |
| `d24cec5e` | a citation listing is a resolution **VERDICT** — cap its capture |
| `c7c85ef3` | an **ENOBUFS git enumeration is not a complete one** |

**Verification machinery that verifies nothing:**
| sha | finding |
|---|---|
| `ab8fe436` | the trap-door sweep **parsed the `ENFORCE` anchor and threw it away** |
| `9e89e360` | repo-root `bin/CLAUDE.md` — the one subsystem catalog the release gate never read |
| `0cf3b8e3` | the R-WACT tsc gate's own checkout-index argv is git-invalid |
| `ff2846d1` | `engines-node-pin.test.js` asserted equality against `release.yml` **alone** — which is how two workflows drifted to a different major with nothing going red |

**Lexical matcher standing in for a semantic question (both directions):**
| sha | finding |
|---|---|
| `853012c1` | a quoted `>` is data, not a redirect — **was blocking worker commits** |
| `dd146e61` | a quoted COMMAND is still an exec — write guard must not demote it |
| `da392255` | quoted-token **bypass** of the expensive-test guard |
| `ea84879e` | read-only `sed` **over-block** of the write guard |

Plus, from `MASTER_PLAN.md`'s own earlier catalogue: the reaper comparing lexical `os.tmpdir()` against
a realpath; the scope fence reporting a **failed staged enumeration as a green pass**; the
missing-timeout matcher firing on `RegExp.prototype.exec`; the bash-scanner blocking an operator command
because PRD **prose** contained a command string; config-protection blocking any command whose *text*
contains a protected filename; the bun probe stripping `PATH` entries whose *path string* contains
`"bun"`.

## Two instances a lint rule CANNOT catch — and they are not optional

1. **`gate/baseline.json` cannot distinguish ran-clean from never-ran.** Measured: it records
   `checks: ["typecheck","lint","tests"]` and `failures: []` with **no per-check ran/skipped field**, on
   a tree known to carry inherited failures. `failures: []` is byte-identical for "clean" and "did not
   run". This is the artifact anatomy-park subtracts from on every iteration.
2. **An agent read absence-from-a-failure-list as passing.** In the `v2.1.0-beta.14` refined PRD the
   operator ruled that `monitor.test.js` "does not fail on Linux" — from CI runs that **died before
   reaching those tests**. It cost that bundle its binding AC. A code lint cannot catch a prose ruling;
   the trap-door/documentation surface must.

## Acceptance criteria

- **AC-1 (regression corpus, binding).** The new check is validated against the **18 shas above**: for
  each, the check must FIRE on the parent commit and NOT fire on the fix commit. A check that cannot
  re-detect the corpus it was built from is not evidence of anything. Report the per-sha result.
- **AC-2 (no new halt path).** The check is an **audit script in the existing release-gate list** and/or
  an eslint rule. It may refuse a LOCAL action (fail the gate for this commit); it MUST NOT introduce a
  new `exit_reason` or break any phase loop (PRIME DIRECTIVE).
- **AC-3 (reuse, do not invent — measured hosts already exist).** Do NOT add a parallel system. Three
  hosts are present and verified at HEAD:
  - **`extension/eslint-plugin-pickle/`** — a bespoke ESLint plugin, wired via `extension/eslint.config.js`
    and documented in `extension/ESLINT_RULES.md`. This is the natural home for the AST-detectable
    sub-patterns (uncapped capture, `spawnSync`/`execFile` result read without a status/`error` check,
    `detached` passed to `execFile`).
  - **`extension/scripts/audit-*.sh`** — 16 scripts, 9 already wired into the release gate. The natural
    home for repo-shaped checks that ESLint cannot see.
  - **the trap-door convention** (`INVARIANT`/`PATTERN_SHAPE`/`BREAKS`/`ENFORCE`,
    `scripts/audit-trap-door-enforcement.sh`, 19 `ENFORCE` references) for what is not mechanical at all.

  **Verify the mechanism you extend actually works before extending it** — `ab8fe436` proved that very
  sweep was parsing the `ENFORCE` anchor and throwing it away, i.e. the trap-door enforcement was itself
  an instance of this defect class.
- **AC-4 (false-positive budget, binding).** Run the check over the whole tree and report the raw hit
  count. **A check that fires on more than it can justify will be disabled by the next engineer**, which
  is worse than no check. If the count is large, narrow to the corpus rather than shipping noise.
  State the final count.
- **AC-5 (`baseline.json` gets a per-check status).** Add a ran/skipped/failed field per check so
  `failures: []` can no longer mean two different things. Do not add gate logic; add the field.
- **AC-6 (the prose surface).** Record ONE trap door stating the rule in a form that applies to analysis,
  not just code: *absence from a failure list is evidence only when the run reached that point.* Cite
  the beta.14 AC-2 miss as its worked example.
- **AC-7 (honest scope).** If a sub-pattern in the corpus is not mechanically detectable, say so
  explicitly and leave it to the trap door. Do NOT stretch a matcher to cover it — the corpus is full of
  matchers stretched past their semantics, and this bundle must not add another.

## Non-goals

Catching every possible instance of the class. Rewriting the reaper, the gate, or the hooks. Any new
`exit_reason`. Any new halt condition. Changing what the review phases do.

## Simplification Review

1. **Necessary?** 18 of ~25 findings in two bundles are one pattern; three sit inside the release gate
   itself. Discovery is not converging.
2. **Reuse?** Yes — the trap-door mechanism, the audit-script list, and the eslint config all exist.
3. **Guards brittle complexity?** It replaces N future point fixes with one check. AC-4 is the guard
   against the check itself becoming the brittle thing.
4. **Subtracts?** It subtracts a recurring discovery cost, and (AC-5) one genuinely ambiguous artifact.
