# B-RSYNCEX — `install.sh`'s rsync walks 601 MB of unmanaged working-dir state, making every install ~30× slower

**Status:** Draft
**Branch:** `release/v2.1-beta`
**Baseline:** `96004ebf` (post-v2.1.0-beta.9)
**build_mode:** `unattended` — this bundle touches `install.sh`'s rsync exclude list and session-root
pruning. It does **not** touch the salvage / completion-evidence / Done-flip seam, so R-PSRB does not
apply. A running pipeline executes deployed JS, and the source diff lands only at `install.sh`.
**Priority:** P1 — one line of exclude list is worth ~20-40× on every `install.sh`, which is 89 % of
`test:integration:serial`'s cost and the reason 13 tests sit at or past their hang-guards.

---

## Summary

`install.sh` spends effectively all of its wall-clock in a single rsync whose exclude list omits the
two directories that dominate the tree:

```
rsync -a --delete --delete-excluded \
  --exclude=node_modules --exclude=src --exclude=tests \
  --exclude=tsconfig.json --exclude=package-lock.json \
  "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"        # install.sh:387-393
```

| Path | Size | Paths walked | Git |
|---|---|---|---|
| `extension/.pickle-rick/sessions/` | **510 MB** | **130,596** | untracked, `extension/.gitignore:32` |
| `extension/.codegraph/` | **91 MB** | 3 | untracked, `.git/info/exclude:19` |
| *actual deployable payload* | **4.9 MB** | ~1,200 | tracked |

**A/B measured 2026-08-10, same machine, data restored afterwards (nothing deleted):**

```
install.sh WITH  the in-tree session pile in the rsync path    329 s   (147-329 s across runs)
install.sh WITHOUT it                                          7-11 s
```

Component costs, for contrast — none of these was ever the bottleneck:

```
npm install (warm)                                  1 s
tsc, cold (.tsbuildinfo deleted, all .js removed)   9 s
codegraph deploy, git mode (symlinks)               0 s
```

### Why it matters beyond install time

13 of the 15 tests that constitute **89 % of `test:integration:serial` test-time** are `install.sh`
invocations. At ~150 s per install they die at their hang-guards; at ~10 s they land far inside their
existing `timeout: 120_000`. **This is why the caps do not need raising** — an earlier draft
recommendation to raise them is withdrawn in
`ANALYSIS-2026-08-10-integration-tier-approach-and-why-the-debt-accumulated.md` (R3 → R0). The caps
were adequate; they were guarding a step bloated by files that never belonged in a deploy tree.

Precedent: **AP-EXT-ITER6-01** already established that `.codegraph` is "the runtime's OWN regenerable
index … plain untracked dirt in any freshly-cloned target repo" and made **every staging path** exclude
it. The install rsync is the one seam that never received the same treatment.

---

## The in-tree session scaffold is DELIBERATE — do not delete it

`createSession` (`extension/src/bin/setup.ts:1583-1591`) creates, on every session:

```ts
const inTreeSessionDir = path.join(process.cwd(), '.pickle-rick', 'sessions', sessionId);
```

…plus a `TASK_NOTES.md` template inside it. **It has a real consumer and a real reason.**
`.claude/commands/szechuan-sauce.md:18-21` names it the *primary* path and states: *"If your sandbox
forbids reads/writes outside the repo tree, use the primary path."*
`.claude/commands/anatomy-park.md:39-41` reads it for prior-pass Dead Ends / Key Discoveries with
`$SESSION_ROOT/TASK_NOTES.md` as fallback.

So this is **not** dead code and **not** a leak to be suppressed. Deleting the write would break
sandboxed microverse workers, which is the one case it exists for.

### The two actual defects

1. **It is not deployable payload, yet it is deployed.** Working-dir state belongs in the working dir.
   The rsync should never have carried it. (WS-A)
2. **It is keyed on `process.cwd()` and never pruned.** `pruneOldSessions(sessionsRoot, maxAgeDays = 7)`
   (`extension/src/services/pickle-utils.ts:2842`) runs against the **canonical** root only, so the
   canonical root holds a healthy **22** sessions / 90 MB while the in-tree root has grown unbounded
   for five months. Because the write is keyed on cwd rather than on the resolved data root, it also
   **bypasses `PICKLE_DATA_ROOT` sandboxing entirely** — 137 test files sandbox their data root
   correctly and every one of them still leaks an in-tree scaffold. That is why
   `audit-test-isolation.sh` passes while the pile grows. (WS-B)

Measured content of the pile — sampled 3,000 of 130,596, **every one** holds exactly one file, an
**empty `TASK_NOTES.md` template** (no `state.json`, no artifacts, ~4 KB of block overhead each):

```
2026-04: 1,917   2026-05: 31,552   2026-06: 35,749   2026-07: 46,503   2026-08: 14,875
```

This is unmanaged scaffolding, not work product. The fix is retention, not a one-off `rm` — otherwise
it regrows.

---

## Simplification Review

1. **Is the addition necessary?** WS-A adds **nothing** — two entries to an existing exclude list. Pure
   removal of work. WS-B adds no new mechanism: it *reuses* the existing `pruneOldSessions` primitive
   against a second root.
2. **Can it REUSE instead of ADD?** Yes, and it must. WS-B MUST call the existing
   `pruneOldSessions(root, maxAgeDays)` — do **not** write a second pruner, and do **not** invent a new
   retention setting when the existing 7-day default already governs the canonical root.
3. **Does it guard existing brittle complexity that should be SUBTRACTED?** It removes the *reason* an
   earlier draft wanted to raise four hang-guard caps. One exclude line retires that whole
   recommendation — the guard was never wrong.
4. **What does this SUBTRACT?** 601 MB and ~130,600 paths from every deploy; ~140-320 s from every
   `install.sh`; and the withdrawn cap-raise. No flag added, no state field, no new gate.

---

## Workstreams

### WS-A — the deploy rsync carries only deployable payload

- AC-A1: **Every** untracked working-dir state directory is excluded from the deploy rsync — concretely
  `.pickle-rick` and `.codegraph` join the existing exclude list in `install.sh`. Verify:
  `grep -c -- "--exclude='\.pickle-rick'" install.sh` is ≥ 1 and likewise for `'\.codegraph'`.
- AC-A2: **For any** deploy root produced by `install.sh`, neither directory appears anywhere beneath
  it. Verify: `PICKLE_INSTALL_ROOT=$(mktemp -d) bash install.sh && find "$PICKLE_INSTALL_ROOT" \( -name '.pickle-rick' -o -name '.codegraph' \) | wc -l` is `0` — Type: integration
- AC-A3: `install.sh` completes in **under 60 s** with the in-tree pile present on disk (measured
  7-11 s clean; 60 s is generous headroom, and the assertion is what proves the exclude actually took
  effect rather than that the machine was fast). Verify: time a full
  `PICKLE_INSTALL_ROOT=$(mktemp -d) bash install.sh` — Type: integration
- AC-A4: The deploy remains correct — `install.sh` still exits 0 and its own post-rsync MD5 parity
  probe (`install.sh:403-424`, 8 files) passes. Verify: `bash install.sh; echo $?` is 0 — Type: integration
- AC-A5: Mutation check — removing either exclude reddens AC-A2, and nothing else.

### WS-B — every session root is pruned, including the in-tree one

- AC-B1: **For every** session root the runtime writes to — canonical *and* in-tree — inactive sessions
  older than the retention window are pruned by the **existing** `pruneOldSessions` primitive. No
  second pruner is introduced. Verify: `grep -c "pruneOldSessions(" extension/src/bin/setup.ts` reflects
  both call sites and no new pruning function is defined — Type: lint
- AC-B2: The in-tree scaffold is **still created** and still reachable at the primary path both
  `.claude/commands/szechuan-sauce.md:18` and `.claude/commands/anatomy-park.md:39` name. This bundle
  must not break the sandboxed-worker case that path exists for. Verify: a test asserts
  `<cwd>/.pickle-rick/sessions/<id>/TASK_NOTES.md` exists after `createSession` — Type: test
- AC-B3: An in-tree session older than the retention window is removed; one inside it survives. Verify:
  a test seeds two in-tree session dirs with `utimes` on either side of the cutoff and asserts exactly
  one remains — Type: test
- AC-B4: Pruning is best-effort and **never** blocks session start — a failure to prune (permissions,
  missing root) leaves `createSession` succeeding. Verify: a test makes the in-tree root unwritable and
  asserts `createSession` still returns a session — Type: test
- AC-B5: Mutation check — removing the in-tree prune call reddens AC-B3 and leaves AC-B2 green.

---

## Out of scope

- **Deleting the existing 130,596-entry pile.** WS-B's retention will drain it on the next run; a
  bulk `rm` is an operator action, not a code change, and is not required for any AC here.
- **Making the in-tree write respect `PICKLE_DATA_ROOT`.** Tempting — it would stop 137 test files
  leaking — but the write is keyed on cwd *by design* so a sandboxed worker can always reach its notes
  inside the repo. Changing the key risks the exact case the path exists for. Retention (WS-B) solves
  the accumulation without touching that contract. Revisit separately with the prompt contract in hand.
- Raising the four install-test hang-guard caps — **withdrawn**, superseded by WS-A.

---

## Bundle-wide gate

Green from `extension/` before this bundle is done. Run the two integration sub-tiers **separately** and
read each by its own `ℹ tests/pass/fail` summary — the composite `test:integration` is
`parallel && serial` and a red parallel half hides the serial one:

```
npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc \
  && bash scripts/audit-test-tiers.sh \
  && bash scripts/audit-test-isolation.sh \
  && bash scripts/audit-subprocess-heavy-tests.sh \
  && bash scripts/audit-trap-door-enforcement.sh \
  && npm run test:fast \
  && npm run test:integration:parallel \
  && npm run test:integration:serial
```

The three audit scripts are named explicitly because npm binds `pre` hooks to literal script names:
there is no `pretest:integration:parallel`, so the split invocation otherwise runs with zero audit
preflight.

**Expected effect on the serial tier — state it as a measurement, not a hope.** Before: 8 install/deploy
failures, every one `exit null` (killed at its hang-guard). After WS-A those installs run in ~10 s and
should pass inside their unchanged `timeout: 120_000`. If they still fail, WS-A did not take effect —
investigate rather than raising a cap.
