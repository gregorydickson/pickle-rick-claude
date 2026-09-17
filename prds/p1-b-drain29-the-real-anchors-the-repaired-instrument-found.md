# B-DRAIN29 — drain the real findings the repaired instrument surfaces

**One root. This is [[B-LENS]] ROOT L7's thesis — *"the loops should fix all issues they find"* — applied
by hand to the first channel that is now trustworthy enough to act on, WITHOUT wiring anything.**

### Why this bundle exists now

`#34` repaired citadel's anchor matcher. **Measured at HEAD by calling the repaired analyzer directly:**

| | before repair | after repair |
|---|---:|---:|
| `ENFORCE anchor … not found` findings | **147** (scoped run) | **29** (whole repo, unscoped) |

Fewer findings over a **larger** surface. My pre-repair prediction was "~26 genuine"; the measured figure
is **29**, within 3. **#34 is field-verified.**

**The 29 are real and unfixed.** They span **24 files**, at most 2 per file. Each is an `ENFORCE:`
reference in a subsystem `CLAUDE.md` naming a test-case anchor that does not exist in the file it points
at — so a documented invariant claims a guard that is not there.

**Why not wire L7 instead:** AC-L7-1 exists to stop a channel being routed before its true-positive rate
is known. Citadel's is now known for this finding class, but the skeptic's repair (#36) has not been
field-verified, and `dropped_findings` is deliberate. **Draining by hand first is the measurement that
tells us what wiring would actually cost.**

---

## 🚧 ROOT D — 29 documented invariants name a guard that does not exist

Each finding is one of exactly two things, and **the ticket must decide which per finding, not in bulk**:

1. **The anchor is stale** — the test exists but was renamed, so the `ENFORCE:` reference should be
   updated to the current title. **This is a doc fix.**
2. **The guard is genuinely missing** — no such test exists, and the invariant is unguarded. **This is a
   test to write**, and it is the one that matters: a `CLAUDE.md` invariant with no live guard is a
   claim with nothing behind it.

**Do not assume all 29 are case 1.** Resolving every one by editing the reference would silently convert
"the guard is missing" into "the docs look right", which is the exact fake-green this repo files against
itself. **Report the split.**

### AC-D
- **AC-D-1 (the count, executable):** after the bundle,
  `node -e "import('./services/citadel/trap-door-coverage-audit.js').then(m=>{const r=m.runT6TrapDoorCoverage({projectRoot:process.cwd()+'/..'});console.log((r.findings||[]).filter(x=>/ENFORCE anchor/.test(x.message)).length)})"`
  **returns 0** — or returns a stated residual with a per-finding reason. A residual is acceptable; an
  unexplained one is not.
- **AC-D-2 (the split is REPORTED):** the commit message states how many of the 29 were stale references
  versus genuinely-missing guards. **A bundle that reports 29 stale and 0 missing must justify that**, as
  it is the result a lazy bulk edit would also produce.
- **AC-D-3 (case 2 writes a real test):** where the guard is missing, the new test asserts the invariant
  the `CLAUDE.md` clause actually states — not a placeholder that merely matches the anchor. **Mutation:
  break the invariant and the new test must RED.**
- **AC-D-4 (executable, and FALSE at HEAD today):**
  `bash scripts/audit-trap-door-enforcement.sh` **exits 0** — it does today too, so it is *not* sufficient
  alone; pair it with AC-D-1, whose count is **29 at HEAD** and must drop.
- **AC-D-5 (do not touch the instrument):** `git diff` shows no edit to
  `extension/src/services/citadel/trap-door-coverage-audit.ts` or
  `extension/scripts/audit-trap-door-enforcement.sh`. The matcher was just repaired; **moving it again to
  make the count fall is tuning, not fixing.**
- **AC-D-6 (no invariant is deleted to clear a finding):** removing an `ENFORCE:` clause is only
  acceptable when the invariant it names is itself obsolete, and then the commit says why. **Deleting the
  claim is the cheapest way to make this bundle green and it is the wrong one.**

## 🛡 PRIME DIRECTIVE compliance

No halt, no abort, no new gate leg, no `EXIT_REASONS` change, no new artifact or contract. This drains
existing findings and adds guards for invariants that already claim to have them.

## Non-goals

- Do NOT wire any channel into the fixing loop — that remains L7, after the skeptic repair is
  field-verified too.
- Do NOT edit the matcher or the shell audit (AC-D-5).
- Do NOT delete an `ENFORCE:` clause merely to clear a finding (AC-D-6).
- Do NOT touch the `acceptance-assertion-coverage-floor.json` ratchet. **This bundle's tickets carry
  executable assertions because that is the fix for #30** — the floor is not the problem.

## Simplification Review

**One root, 24 files, at most 2 findings each.** The work is naturally partitioned by file and needs no
shared state, so the only real risk is the bulk-edit shortcut AC-D-2 and AC-D-6 exist to expose.
