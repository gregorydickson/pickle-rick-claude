# B-LASTBUG — the inert gate, and the standing debt behind it

**Three roots, measured at HEAD `057d94d9`.** P1 is the last open bug in the tracker. P2 and P3 are the
standing quality debt the ratchet exists to drain. After this the queue is enhancements.

**Order: P1 first.** It is the only root that is a defect; the other two are debt with an armed ratchet.

---

## 🕳 ROOT P1 — the coverage gate cannot see what it watches (GitHub #26)

`audit-acceptance-assertion-coverage.sh` exists to catch an authoring regression: if an authoring path
stops emitting the backticked `` `<command>` exits|returns <N> `` form, every new ticket goes unguarded.

**It scans the git index.** All 38 tracked `rick_ticket_*.md` files are hand-written fixtures under
`extension/tests/fixtures/mmtr6-synthetic-session/`. The tickets it is *about* are written to session
directories at runtime and are never scanned.

| corpus | AC sections | guarded |
|---|---|---|
| git index (what it scans) | 8 | **1** |
| live session output (what it is about) | 11 | **7** |

So the ratcheted fraction **cannot move when an authoring path changes** — the regression it was built
to detect. Worse, it is wired into the release gate, so it will read as increasingly reassuring while
measuring nothing about the risk. The script already accepts `ACCEPTANCE_COVERAGE_ROOT_OVERRIDE`;
nothing sets it.

### AC-P1 (machine-checkable)
- P1-1: the audit measures the population at risk — real authoring output — when a session root is
  resolvable.
- P1-2: when it falls back to another corpus, the fallback is **NAMED IN THE OUTPUT**. A silent fallback
  reproduces this exact bug one layer down.
- P1-3 (the falsifying control, load-bearing): break an authoring path's emitted form and the measured
  fraction MOVES. A gate that stays green through that is not measuring authoring, and this AC is the
  whole point of the root.
- P1-4 (over-trigger control): a corpus with zero acceptance sections is reported as unmeasured, not as
  0% coverage. An absent measurement is not a failing one.
- P1-5: the recorded floor is re-derived against the corrected corpus and can still only be raised.
- P1-6 (mutation): restore the index-only scan; P1-3 goes RED.

**Non-goal:** do NOT make the audit depend on a live pipeline being present. It must produce an honest,
named verdict on a machine with no sessions at all.

---

## 🪓 ROOT P2 — ratchet the loop again, 449 → ≤225

`runMuxRunnerMain` is **449 code lines, complexity 84**, recorded in its marker and enforced by
`audit-recorded-ceilings.sh`. Ceilings are 120 and 15. It is now the **only** carve-out in the tree
carrying figures, and `eslint src/` reports zero other functions over either ceiling.

Three bundles have taken it 1690 → 892 → 449. Same discipline again.

### AC-P2 (machine-checkable)
- P2-1: `runMuxRunnerMain` measures **≤225 code lines and complexity ≤45**.
- P2-2: recorded figures updated; `audit-recorded-ceilings.sh` passes against them.
- P2-3 (behaviour): STRUCTURAL ONLY. No exit reason, disposition, activity event, ordering or state
  write may differ. Full fast and integration tiers pass unchanged.
- P2-4: every extracted helper is itself under 120/15 and carries NO disable.
- P2-5 (mutation): a behavioural mutation inside any extracted helper must red an existing suite. If an
  extraction is covered by nothing, SAY SO in the ticket rather than claiming it is safe.

**Non-goal:** do NOT change any decision the loop makes. File defects found; fix them separately.

---

## 🧱 ROOT P3 — continue the bounded split of the catch-all module

`services/pickle-utils.ts` is **2160 lines** (was 3232; B-RATCHET R5 took the first two concerns).
Extract the next two cohesive concerns.

### AC-P3 (machine-checkable)
- P3-1: at least two further cohesive concerns extracted; `pickle-utils.ts` drops below **1500 lines**.
- P3-2 (structural only): every moved symbol keeps its name and behaviour. Import paths preserved by
  re-export, or every call site updated in the same commit.
- P3-3: Module Export Catalog entries regenerated and correct; catalog audits pass.
- P3-4: full fast and integration tiers pass unchanged.
- P3-5: no extracted module carries a new disable or exceeds 120/15.

---

## 🛡 PRIME DIRECTIVE compliance

P1 repairs an audit — a gate that refuses a COMMIT, never a run — and its P1-4 makes an absent
measurement report as absent rather than as failure. No halt, no abort condition, no phase-loop break.

P2 and P3 are the brittleness clause applied directly, continuing a ratchet that is already armed and
fails in both directions.

P1 is also the enumerated-liability fix in its purest form: a gate measuring a hand-maintained fixture
set instead of the live population, which is how a catalog rots green.

## Non-goals

- Do NOT make P1 depend on a live pipeline being present.
- Do NOT let P1 fall back silently (P1-2).
- Do NOT change any decision the loop makes (P2 non-goal).
- Do NOT aim `runMuxRunnerMain` at 120 in this bundle; the ratchet finishes it.
- Do NOT fully decompose `pickle-utils.ts`; P3-1 is the bounded target.

## Simplification Review

Named subtractions: P1 removes a false signal from the release gate, which is worth more than the line
count suggests, since a green check that measures nothing is worse than no check. P2 removes roughly 224
code lines and 39 complexity from the single most complex function in the codebase. P3 removes at least
660 lines from a catch-all module.

The recurring shape, for the fourth bundle running: **a measurement that names one thing and measures
another.** P1 is that shape in a gate; P2 and P3 reduce the surface where it can hide.
