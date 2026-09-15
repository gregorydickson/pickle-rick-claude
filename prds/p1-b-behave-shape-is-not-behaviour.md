# B-BEHAVE — shape is not behaviour

**Two roots, measured at HEAD `2152fb29`.** Both are the same defect wearing different clothes: a
SHAPE was checked and read as a BEHAVIOUR. R1 is blocking the release gate right now.

**Order: R1 first.** It is the live gate red.

---

## 🚧 ROOT R1 — documenting a form did not change what gets authored (GitHub #30, GATE-RED)

beta.31 documented the executable-assertion form in every authoring path, with worked backticked
examples each verified to parse with `EXECUTABLE_ASSERTION_RE`. **The next run authored three tickets
and none used it.**

The coverage ratchet caught it on its first real opportunity and is **failing the release gate now**:

```
audit-acceptance-assertion-coverage: 72 tickets scanned, measured 13/43 guarded,
  recorded session_min_ratio 13/40 — below floor
```

Denominator grew by 3, numerator unmoved. All three are the B-ZERO run, authored after the docs landed:

| ticket | `## Acceptance Criteria` | backticked assertions |
|---|---|---|
| `742e1985` | yes | **0** |
| `9caa2556` | yes | **0** |
| `a3a60a1a` | yes | **0** |

The docs are present and correct — 3 worked examples, each extractor-verified. So this is not stale
documentation. **Asking was necessary and has been measured as insufficient.**

**The knock-on:** the Done-flip guard shipped in beta.30 runs a ticket's executable assertion and parks
on failure. With no ticket carrying one, that guard is **inert for everything authored since**.

### AC-R1 (machine-checkable)
- R1-1: a ticket authored through the REAL authoring path emits an acceptance section that parses with
  `EXECUTABLE_ASSERTION_RE`. **Assert on authored output, not on documentation** — anything weaker
  measures the docs again.
- R1-2: the coverage ratio RISES above the recorded floor and the audit passes, restoring the gate.
- R1-3: a criterion that genuinely cannot be expressed as a command stays valid prose and is NOT forced
  into a fake command. Inventing commands to satisfy a counter is worse than the gap.
- R1-4 (over-trigger control): existing tickets are not rewritten and the floor is not lowered to pass.
- R1-5 (mutation): revert the authoring change; R1-1 goes RED.

**Pick ONE of these shapes, do not stack them:** a template slot the author fills, a post-authoring
normalisation pass over criteria already phrased as commands, or an AC-shape gate rejection with a
fix-it message. **If none proves reliable, the honest option is on the table:** state that prose
criteria are first-class, retire the Done-flip guard's reach, and say so — better than a permanently
inert guard.

---

## 🧪 ROOT R2 — the most-refactored function has no behavioural coverage (GitHub #29)

`runMuxRunnerMain` decides ticket lifecycle, salvage and Done-flips. Across five bundles it went
**1690 → 217 code lines** and **complexity 366 → 38**, every step declared behaviour-preserving.

```
src/bin/mux-runner.ts:16388   async function runMuxRunnerMain() {   <- no `export`

references in tests/:  37
  imports or call sites: 0
  text mentions:        37
```

All 37 are assertions about the function's TEXT. The three newest helpers
(`runPreSpawnLivenessWatchdogs`, `classifyAndRecordIterationEnd`, `muxEpicFinalizeScan`) have **zero**
test references each. The Q3 ticket disclosed this itself: *"the loop is unexported and no suite drives
it. The source-text pins constrain their SHAPE only."*

**Not claimed:** that any of the five refactors introduced a defect. The checkable claim is narrower —
**the evidence offered cannot detect the failure it is said to rule out.** A source-text pin cannot
distinguish a correct extraction from one that reorders two effects, drops a branch, or changes an early
return, which are exactly the mistakes extract-method makes.

### AC-R2 (machine-checkable)
- R2-1: a suite DRIVES the loop — exported, or a drivable core extracted — and asserts its observable
  outputs: exit reason, disposition, activity events, ordering, state writes.
- R2-2 (the control that makes this worth doing): introduce a deliberate behavioural change — reorder
  two effects, or drop a branch — and the new coverage REDS. **If it stays green, the coverage is
  shape-checking in a new costume and the root is not done.**
- R2-3: at least the three uncovered helpers above gain behavioural coverage.
- R2-4: existing source-text pins are NOT deleted. They constrain shape usefully; they simply are not
  behaviour. This root adds evidence rather than trading one thin signal for another.
- R2-5: no behaviour changes. If driving the loop reveals a defect, FILE it and leave behaviour intact.

**Sequencing note:** the ratchet is blocked at 217 lines by out-of-fence pins in
`szechuan-sauce.test.js` (M4-2/M4-3). Do NOT resume the ratchet here. Real coverage is what would make
resuming safe, which is the point of doing R2 before any further extraction.

---

## 🛡 PRIME DIRECTIVE compliance

Neither root adds a halt, an abort condition, or a phase-loop break. R1 repairs a gate that refuses a
COMMIT. R2 adds test coverage and changes no behaviour.

R1 is the enumerated-liability lesson again: a convention maintained by asking people to remember it is
correct only until someone does not.

## Non-goals

- Do NOT lower the coverage floor to green the gate (R1-4).
- Do NOT invent commands for criteria that are genuinely prose (R1-3).
- Do NOT stack all three R1 mechanisms; pick one and measure it.
- Do NOT delete existing source-text pins (R2-4).
- Do NOT resume the size ratchet in this bundle.
- Do NOT change loop behaviour to make it testable (R2-5).

## Simplification Review

R2 is the honest addition: five bundles of refactoring have been resting on shape pins, and this buys
the evidence that was assumed. R1 is a replacement, not an addition — a convention that relies on memory
swapped for a mechanism that does not.

The shape, for the fifth bundle running: **something checked the form and was read as checking the
substance.**
