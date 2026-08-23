# BUG-2026-08-14 — tier evidence for the salvage hold-release bundle

Ticket `aafc633a`. Branch `release/v2.1-beta`, commit `cf040295` ("fix(aafc633a): release
failed_flip_suppressed hold at the shared exit-commit salvage seam"). Recorded 2026-08-23.

Every count below is quoted verbatim from a captured runner summary block or sidecar. Where a
value was not captured, it is recorded as `unmeasured` rather than as `0` or a pass. Measurement
preconditions: Node `v24.19.0` (recorded in every sidecar for this ticket), sha `cf040295`, branch
`release/v2.1-beta`, `git_config_scrubbed: 0` in every sidecar, all commands run from `extension/`.

## 0. The bundle's claim

`routeExitPathSalvage`'s `SalvageDeps` stubbed `resetTodo` to a no-op, "for parity with legacy".
But `resetTodo` is the ONLY automatic `status: Todo` writer in the whole salvage runtime, and
`readActiveFailedFlipHolds` releases a `failed_flip_suppressed` hold only on the literal
frontmatter status `"todo"`. With the seam's `resetTodo` stubbed, a held ticket could never become
selectable again, so `noRunnableTicketsRemain` reported `true` for an otherwise-runnable roster and
the L5 `empty_roster_all_failed_no_runnable` terminal fired over work that should have continued.

The fix implements `resetTodo` the same way `salvage-ticket.ts`'s own default does
(`updateTicketFrontmatter` → `status: 'Todo'`); `archive` stays a no-op — that half of "parity with
legacy" (never discard a gate-failing dirty tree at this seam) is unaffected. All three
`routeExitPathSalvage` call sites (`extension/src/bin/mux-runner.ts:11359`, `:11452`, `:11528`)
share this one function, so the fix covers them by construction — confirmed by `git diff` showing
exactly one hunk inside `routeExitPathSalvage` (function definition at `:6441`) and zero edits at
the three call sites (ticket `aafc633a` conformance, AC-3). This ticket records durable, auditable
tier evidence for that claim.

## 1. Measurement note — tiers captured by the manager, not this worker

`integration:serial` alone takes ~464s (7.7 minutes); a worker attempting the three-tier sequence
plus targeted tests and typecheck in the foreground would be killed mid-run by the 600s foreground
ceiling before writing anything durable. The manager ran all tiers directly, with the ambient
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`/`PICKLE_TICKET_ID` environment scrubbed
(every sidecar for this ticket records `git_config_scrubbed: 0`), per prior-session memory
`ambient-git-config-false-gate-reds.md`. Captures live under `<TICKET_DIR>/tier-captures/`:
`fast.log`, `integration-parallel.log`, `integration-serial.log`, `targeted-salvage.log`,
`typecheck.log`, each with a `.meta.txt` sidecar recording node version, sha, branch, census
before/after with load averages and top CPU consumers by name, exit code, and wall seconds. This
worker re-reads those captures rather than re-running the tiers.

## 2. Before/after incident-roster evidence (ticket `aafc633a`, AC-2)

Source: `../aafc633a/conformance_2026-08-23.md`, AC-2 row, quoted verbatim:

> Before fix: `readActiveFailedFlipHolds(...).has(ticketId) === true` and
> `noRunnableTicketsRemain(...) === true` (incident reproduced). After `routeExitPathSalvage`: both
> flip to `false`. Both consumers (`advanceOrExitOnLadderExhaustion` at `:9003` and the main-loop L5
> check at `:11040-11047`) call the same `noRunnableTicketsRemain`/`findNextPendingTicketId` chain
> this test drives directly — no per-consumer duplicate test needed.

Before the fix, the incident reproduces exactly as claimed: `readActiveFailedFlipHolds(...)` holds
the ticket id, `noRunnableTicketsRemain(...)` reports `true` for the lone-ticket roster, and the L5
`empty_roster_all_failed_no_runnable` terminal fires. After the fix, `routeExitPathSalvage` releases
the hold — both flip `false` — so `resolvePreTicket` (`extension/src/bin/mux-runner.ts:1549`,
called at `:10890`) re-resolves a runnable ticket instead of returning `null`, and the terminal does
NOT fire.

### The release condition is the literal frontmatter status `"todo"` — not a `Failed` flip

Verified directly against `extension/src/bin/mux-runner.ts` at HEAD (`cf040295`):
`readActiveFailedFlipHolds` (defined `:9710-9726`) builds the held-ticket set from
`state.json.recovery_attempts` entries whose `strategy === FAILED_FLIP_SUPPRESSED_STRATEGY` and
`outcome === 'success'` (`:9715-9718`), then releases each held id **only** when
`normalizeTicketStatus(getTicketStatus(sessionDir, id)) === 'todo'` (`:9722`) — the function's own
docblock states the invariant directly: "frontmatter `status: Todo` releases the hold — same heal
flow as oversized_no_progress" (`:9706`). A ticket flipped to `Failed` (or any other status) does
**not** satisfy this check and stays held. This means the fix cannot be short-circuited by treating
a `Failed` flip as equivalent to release: `resetTodo`'s new implementation writes the literal
`status: 'Todo'` via `updateTicketFrontmatter` (mirroring `salvage-ticket.ts`'s own
`defaultDeps.resetTodo`, `:115-117`), which is the one and only write path that satisfies
`readActiveFailedFlipHolds`'s oracle. The trap the bundle closes — a held ticket that can never
become selectable again — is not reintroduced by any partial fix that flips status to `Failed`
instead of `Todo`.

## 3. `recovery_exhausted` (CUJ-1 handoff) is the designed terminal and was left intact

`recovery_exhausted` is a structurally separate terminal from the L5
`empty_roster_all_failed_no_runnable` path this bundle touches: it is reached via
`pickle-recover.ts --reactivate` (entry-state gate at `pickle-recover.ts:198-220`, entry constant
`RECOVERY_ENTRY_STATE = 'recovery_exhausted'` at `:40`), not via `routeExitPathSalvage` or
`readActiveFailedFlipHolds`. Ticket `aafc633a`'s AC-4 confirms no call relationship exists between
the two, and the fix commit's diff touches only `mux-runner.ts`/`mux-runner.js`,
`salvage-ticket-matrix.test.js`, and `lib/CLAUDE.md` — zero lines in `pickle-recover.ts`.

`tests/recovery-exhausted-terminal.test.js` (139 lines, 8 `test()` blocks) is unmodified by this
bundle. From `tier-captures/targeted-salvage.log` (manager-captured, verbatim):

```
▶ AC-W4b-3 terminal-literal grep — only recovery_exhausted is the honest ladder terminal
  ✔ the empty-roster all-Failed path terminates into recovery_exhausted (0.56875ms)
  ✔ the retired legacy all_tickets_terminal literal does not reappear (0.216167ms)
  ✔ no NEW honest-terminal literal sibling is introduced — recovery_exhausted is the single ladder terminal (0.69875ms)
✔ AC-W4b-3 terminal-literal grep — only recovery_exhausted is the honest ladder terminal (2.010458ms)
▶ AC-W4b-3 handoff artifact — writeRecoveryHandoffArtifact
  ✔ writes recovery_handoff.md with a ## Recovery Handoff header naming pickle-recover (0.92825ms)
  ✔ empty/absent ticket still names the re-queue subcommand (empty-roster handoff) (0.471917ms)
  ✔ is best-effort — a non-existent session dir does not throw (0.164ms)
✔ AC-W4b-3 handoff artifact — writeRecoveryHandoffArtifact (1.682958ms)
▶ AC-W4b-3 empty-roster resolution
  ✔ roster all-Done -> completion (applyAllTicketsDoneCompletion synthesizes EPIC_COMPLETED) (11.985375ms)
  ✔ roster all-Failed (no runnable) does NOT resolve to completion via the all-Done check (1.062791ms)
✔ AC-W4b-3 empty-roster resolution (13.176917ms)
```

This is the 8/8 pass for the `recovery_exhausted`/CUJ-1 handoff suite (three describe blocks × the
counts above: 3 + 3 + 2 = 8 tests), unchanged by this bundle. `recovery_exhausted` remains the
single honest ladder terminal — the fix narrows when the roster genuinely has no runnable tickets
left; it does not touch what happens once that terminal legitimately fires.

## 4. Ticket `aafc633a`'s own dedicated bundle suite (targeted-salvage.log, verbatim)

From `tier-captures/targeted-salvage.log`:

```
▶ routeExitPathSalvage: shared dep-set release wiring (aafc633a)
  ✔ AC-1: a gate-failing dirty tree resets frontmatter status to the literal "todo" (84.958167ms)
  ✔ AC-2: releasing the hold clears readActiveFailedFlipHolds and noRunnableTicketsRemain for the lone-ticket roster (77.393542ms)
  ✔ a gate-passing dirty tree still commits + Done (archive/resetTodo path not taken) (133.756666ms)
✔ routeExitPathSalvage: shared dep-set release wiring (aafc633a) (296.218417ms)
ℹ tests 35
ℹ suites 31
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 370.997625
```

`node --test tests/salvage-ticket-matrix.test.js tests/recovery-exhausted-terminal.test.js`
(combined run): 35/35 pass, 0 fail, 0 cancelled — this includes both the full salvage matrix
(`AC-W3-1`: 5 seams × 4 tree-states = 20 tests) and the `recovery_exhausted` suite from Section 3
run together in the same process, confirming no cross-suite interference. Sidecar: `exit: 0`,
`wall_seconds: 0` (sub-second run, rounds to 0 in the integer capture), census before/after
identical (`06:13:13Z` both, load averages `1.46 2.32 2.64` unchanged — too fast to move the
1-minute load average).

## 5. Tier results at `cf040295`

### fast (`npm run test:fast`, scrubbed)

Node `v24.19.0`. Census before: `2026-08-23T05:59:33Z`, `0:59 up 297 days, 10:58, 2 users, load
averages: 3.15 2.88 2.03`. Top CPU consumers before: `XprotectService` 50.4%, `claude` 3.2%,
`syspolicyd` 2.8%, `trustd` 1.9%, `claude` 1.3%, `bash` 0.7%. Census after:
`1:02 up 297 days, 11:01, 2 users, load averages: 6.61 5.70 3.43` (load rose — a real load-generating
run, not idle). Top CPU consumers after: `fseventsd` 61.1%, `XprotectService` 29.5%, `mds_stores`
12.1%, `mds` 10.6%, `claude` 1.0%, `syspolicyd` 1.0%.

```
ℹ tests 7858
ℹ suites 518
ℹ pass 7851
ℹ fail 1
ℹ cancelled 0
ℹ skipped 5
ℹ todo 1
ℹ duration_ms 167099.633875
```

EXIT=1, `wall_seconds: 184`. The single failure is `tests/install-bun-probe.test.js:20:3` ("bun
probe emits banner when bun is absent") — see Section 6, INHERITED/filed, unrelated to this bundle.

### integration:parallel (`npm run test:integration:parallel`, scrubbed)

Node `v24.19.0`. Census before: `2026-08-23T06:02:49Z`, `1:02 up 297 days, 11:02, 2 users, load
averages: 5.44 5.48 3.39`. Top CPU consumers before: `claude` 7.9%, `claude` 0.8%, `node` 0.4%,
`node` 0.3%, `searchpartyd` 0.2%, `WindowServer` 0.2%. Census after:
`1:05 up 297 days, 11:04, 2 users, load averages: 1.88 4.16 3.17`. Top CPU consumers after:
`fseventsd` 32.9%, `mds_stores` 11.8%, `mds` 10.4%, `launchservicesd` 7.9%, `loginwindow` 5.0%,
`coreservicesd` 2.4%.

```
ℹ tests 639
ℹ suites 21
ℹ pass 638
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 137801.97
```

EXIT=1, `wall_seconds: 138`. The single failure is `tests/integration/extension-wiring.test.js:60:1`
("deploy smoke: gate bins and data exist after bash install.sh"): `Missing deployed paths (run bash
install.sh): /Users/gregorydickson/.claude/agents/morty-gate-remediator.md` — see Section 6,
INHERITED/filed, a `bash install.sh` deployment-freshness gap on this operator box, unrelated to the
salvage hold-release fix.

### integration:serial (`npm run test:integration:serial`, scrubbed)

Node `v24.19.0`. Census before: `2026-08-23T06:05:15Z`, `1:05 up 297 days, 11:04, 2 users, load
averages: 1.75 4.05 3.15`. Top CPU consumers before: `claude` 4.5%, `claude` 0.9%, `airportd` 0.6%,
`WindowServer` 0.3%, `Google Chrome Helper (Renderer)` 0.3%, `node` 0.3%. Census after:
`1:12 up 297 days, 11:12, 2 users, load averages: 1.42 2.36 2.66`. Top CPU consumers after: `claude`
0.8%, `fseventsd` 0.6%, `launchservicesd` 0.6%, `XprotectService` 0.5%, `loginwindow` 0.4%, `claude`
0.4%.

```
ℹ tests 608
ℹ suites 24
ℹ pass 608
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 464150.40225
```

EXIT=0, `wall_seconds: 464`. Clean pass, 0 fail, 0 cancelled. Includes
`R-CWGE WS-1: test:fast timeout yields exactly one __timeout__ failure and ok:false` and the full
`tsc-gate`/`finalize-gate`/`isGitCommitCommand` suites, all passing.

**All three broad tiers plus the targeted-salvage run: `cancelled 0`.** Node `v24.19.0` and
`git_config_scrubbed: 0` confirmed directly in every sidecar for this ticket (fast,
integration-parallel, integration-serial, targeted-salvage, typecheck) — no field recorded as
`unmeasured` for this bundle's captures.

## 6. Type check

From `tier-captures/typecheck.meta.txt`: `cmd: npx tsc --noEmit`, `node: v24.19.0`, `sha: cf040295`,
`git_config_scrubbed: 0`, `exit: 0`, `wall_seconds: 3`. `tier-captures/typecheck.log` is 0 bytes —
`tsc --noEmit` prints nothing on a clean pass, so an empty log with `exit: 0` is the expected
clean-pass signature, not a missing capture. Census before: `1:13 up 297 days, 11:12, 2 users, load
averages: 1.46 2.32 2.64`; census after: `1:13 up 297 days, 11:12, 2 users, load averages: 1.59 2.33
2.64`. Matches ticket `aafc633a`'s own conformance record (`npx tsc --noEmit` — "Exit 0, no output")
for the same fix commit.

## 7. AC disposition

| AC | Requirement | Result |
|---|---|---|
| Evidence doc records the incident roster before/after (terminal fires vs does not) | met — Section 2, verbatim quote of `aafc633a` AC-2 plus independent line-level verification of `readActiveFailedFlipHolds`/`resolvePreTicket` at HEAD |
| All three tiers recorded with census and load average | met — Section 5, all three tiers (fast, integration:parallel, integration:serial) have census before/after and load averages; Section 4 adds the targeted-salvage census |
| A `Failed` flip does NOT release the hold, so the trap is not reintroduced | met — Section 2, the literal-`"todo"` release condition verified directly against `mux-runner.ts:9706-9722` at HEAD |
| `recovery_exhausted` is the designed CUJ-1 handoff, left intact | met — Section 3, 8/8 pass verbatim from `targeted-salvage.log`, zero diff in `pickle-recover.ts` |
| Remaining failures named and attributed as the two filed inherited ones | met — Section 8 |

## 8. Attribution — the two remaining tier-level reds predate/are outside this bundle

- `tests/install-bun-probe.test.js` (fast tier) — pre-existing environmental flake, recorded
  identically failing in prior evidence docs (`extension/docs/bug-2026-08-22-ac6-guard-evidence.md`,
  Section 6, itself citing `bug-2026-08-20-trailer-normalization-evidence.md` and
  `bug-2026-08-19-tier-evidence.md`). INHERITED, filed.
- `tests/integration/extension-wiring.test.js` (integration:parallel tier) — `bash install.sh`
  deployment-freshness gap on this operator box (missing deployed
  `~/.claude/agents/morty-gate-remediator.md`), recorded identically in
  `bug-2026-08-22-ac6-guard-evidence.md`, Section 6. INHERITED, filed, unrelated to the salvage
  hold-release seam.

**Disposition: the bundle's thesis holds.** The before/after incident roster reproduces and then
resolves exactly as claimed (`readActiveFailedFlipHolds`/`noRunnableTicketsRemain` both flip
`true → false`, `resolvePreTicket` re-resolves a runnable ticket, the L5 terminal does not fire);
the release condition is provably the literal frontmatter status `"todo"` (a `Failed` flip does not
satisfy it, so the trap is not reintroduced); `recovery_exhausted`/CUJ-1 is unmodified and still
8/8; the ticket's own dedicated suite is 35/35; and all three broad tiers plus the targeted run
report `cancelled 0`, with the only two remaining tier-level reds being the same pre-existing
inherited failures recorded in this repo's prior evidence docs — reported honestly here rather than
omitted, per this repo's PRIME DIRECTIVE (report degradation, do not halt, do not silently convert a
red into a pass).
