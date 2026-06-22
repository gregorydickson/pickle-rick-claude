# BUG REPORT — Completion-evidence fatal on CLAUDE backend; salvage-loops an already-committed ticket and strands the next ticket's work

**Date:** 2026-06-20
**Finding code:** R-CECB (Completion-Evidence, Claude Backend) — instance of the open completion-commit cluster
**Priority:** P3 (capture-only — sanctioned recovery exists; cluster already has drafted/shipped fix bundles)
**Status:** OPEN / capture-only (filed while babysitting a real run)
> **✅ RESOLVED v2.0.0-beta.22 (2026-06-21) — B-PCOMP WS-D2.** Salvage clean-tree back-fill via the shipped `readEvidence` oracle (`400fe433`) — committed-green tickets reach `committed-done`, never the fatal/salvage-loop; bystander work stashed not discarded (`aff2cfd4`). Live-confirmed (R-WSDO 4/4 hands-off, zero salvage-loops). Residual: GA soak still needs a LIVE multi-ticket run.

**Family:** open completion-commit / Done-flip cluster — [[R-AFCC]], [[R-RIC]], [[R-CCC]] (codex-spark workers skip completion_commit frontmatter; phantom-Done watcher reverts real commits), [[B-WUWC]]/[[R-CCQF]] (`done_without_commit_evidence` exit_reason), and the caveat [[B-PDBL]] (inferred completion_commit drives phantom-Done backfill loop + dirty-tree relaunch block). Closely mirrors `BUG-REPORT-2026-06-19-codex-worker-commit-missing-ticket-hash-completion-evidence-fatal-halt.md` — **but on the claude backend, not codex.**

## Summary
A pickle build worker (backend=**claude**) implemented ticket 4059a948 and produced a real
git commit, but **did not record the commit as attributable completion evidence** (no
`completion_commit:` in ticket frontmatter, and the commit subject was not hash-attributable
to the ticket). On subsequent mux-runner iterations `readEvidence().kind === 'absent'`, so the
runner treated the already-committed ticket as unfinished, **salvage-looped** it
(`[salvage] 4059a948: failing -> archived diff + reset Todo` ×2), then went
`[fatal] ticket 4059a948 cannot flip Done: readEvidence().kind === 'absent' (expected
'explicit'); worker did not produce an attributable git commit`. Pickle phase exited
`done_without_commit_evidence`, `Pipeline finished: 0/4 phases, 35m 57s`.

**New/notable vs the prior codex reports:**
1. **Claude backend** — prior cluster reports (R-CCC, the 2026-06-19 report) are codex/codex-spark
   workers. This confirms the same missing-frontmatter→fatal path on the **claude** backend.
2. **Bystander work stranded** — while the runner burned all iterations salvage-looping the
   already-committed ticket 1, the **next ticket (a4c721f2 / LOA-1368) had its full
   implementation sitting UNCOMMITTED in the dirty tree** (≈336 LOC: schema fields, a new
   `site-extraction.spec.ts`, reducto JSONs, registry) — verified green (typecheck + lint +
   395 tests) but at risk of the salvage archiver. The fatal on ticket 1 prevented ticket 2
   from ever being committed.

## Repro (real run)
- Session `2026-06-20-4124c822` (pipeline-4124c822), backend=claude, scope=branch, worktree
  `deephaven-phase-1.5-worktree`, 6 serial additive-extraction tickets.
- mux-runner.log: iter2 `[salvage] 4059a948 ... reset Todo`; iter3 same; iter4
  `[fatal] ... readEvidence().kind === 'absent'`. `git log origin/main..HEAD` showed the real
  commit `2312b4e8c feat: 1.A — ... (LOA-1367)` existed the whole time.

## Root cause
`hasCompletionCommit` / `readEvidence` require the commit be attributable to the ticket
(explicit `completion_commit:` frontmatter, or a hash/ref-code-attributable subject). The
claude worker committed with a human-style subject (`feat: 1.A — ... (LOA-1367)`) and did NOT
write `completion_commit:` frontmatter → evidence "absent" → the Done-flip gate refuses, and
the salvage path (mistaking committed work for failing work) archives + resets it. This is the
same defect class the cluster has chased for ~6 failed-fix recurrences; this instance shows it
is **not codex-specific**.

## Impact
- A whole 36-minute build phase consumed salvage-looping ONE already-done ticket; 0/4 phases.
- The next ticket's verified-complete work was left uncommitted and would have been archived by
  the salvage path on the next failing-detection — silent loss risk.

## Recovery used (sanctioned, verified)
1. `git log origin/main..HEAD` to find the real commit; verified ticket-2 dirty work green
   (typecheck + lint:quiet + 395 targeted tests) and committed it (`8d033d92e feat: 1.B — ...
   (LOA-1368)`) so salvage can't archive it.
2. Added `completion_commit: <shortsha>` + `status: "Done"` to both finished tickets' frontmatter.
3. Set `state.flags.allow_inferred_completion_commit = true` (the fatal's own suggested bypass).
   **⚠️ CORRECTION (verified below): this did NOT stop recurrence** — see "Per-ticket recurrence" section.
4. Reset `step=research`, `current_ticket=<next Todo>`, `active=false`; relaunched. Build resumed
   (no fatal at launch; scope now resolves a real branch diff) — but fataled again one ticket later.

## ⚠️ Caveat on the recovery (per B-PDBL)
`allow_inferred_completion_commit=true` is the runner's suggested bypass, but **B-PDBL**
documents that inferred completion_commit can drive a **phantom-Done backfill loop** (observed
1.9 MB state bloat) and a **dirty-tree relaunch block**. The babysitter should watch for: state.json
growth, repeated phantom-Done events, or dirty-tree FATAL on relaunch. If those appear, prefer
the **explicit** path (per-ticket `completion_commit:` frontmatter) and unset the inferred flag.

## Proposed remediation (not done — capture only)
1. **Worker contract enforcement on claude backend too:** the completion-commit frontmatter
   write must be backend-agnostic; if R-CCC's codex fix is codex-only, extend it to claude.
2. **Don't salvage a ticket whose work is already committed on the branch:** before
   `[salvage] ... reset Todo`, check `git log <base>..HEAD` for an attributable commit and
   prefer back-filling `completion_commit` over archiving + resetting (avoids destroying done work
   and burning the whole phase on one ticket).
3. **Protect bystander tickets:** a fatal on ticket N must not strand ticket N+1's uncommitted
   green work — commit-or-stash before terminating the phase.

---

## Additional confirmed instance — 2026-06-20 (session 575e20b3, Statement Analyzer / LOA-1365)

Second independent recurrence the same day, different worktree, confirming the defect is **not session- or PRD-specific**:

- Session `2026-06-20-575e20b3` (pipeline-575e20b3), backend=claude, scope=branch, worktree `loa-1365-worktree`, 22-ticket combined Asset+Income build.
- Ticket `e13f9264` (order 10) built real code and committed `dcde06041 feat: 1.1 — asset_accounts table … (LOA-1365)`. mux-runner then: iter1 `[salvage] e13f9264: failing -> archived diff + reset Todo`; iter2 marked Done + emitted `<promise>TASK_COMPLETED</promise>`; at phase-exit `[fatal] ticket e13f9264 cannot flip Done: readEvidence().kind === 'absent'` → `exit_reason=done_without_commit_evidence` → `Pipeline finished: 0/4 phases, 15m 13s`. Same human-style commit subject (no hash attribution, no `completion_commit:` frontmatter).
- **Recovery used (worked):** set `state.flags.allow_inferred_completion_commit=true` + stamped `completion_commit: dcde06041` in the ticket frontmatter; reset the in-progress ticket to Todo; `setup.js --resume` then hand-patched terminal state (`active/step/iteration`) back to runnable (resume does NOT clear `step:completed/active:false`). Relaunch logged `Phantom-Done watcher kept ticket e13f9264 Done — valid completion_commit evidence` and advanced.

## Per-ticket recurrence — `allow_inferred_completion_commit=true` is INSUFFICIENT (session 4124c822 follow-on)

The most actionable finding: the runner's own suggested bypass **does not work for pickle's own commit style.** After the initial recovery set `allow_inferred_completion_commit=true` and relaunched, the build advanced exactly ONE ticket then **fataled again** on the next Done-flip — and repeated for every subsequent ticket:

- Relaunch #1 → ticket `eeae8feb` (LOA-1369) built + committed `8822bbae3 feat: 1.C — … (LOA-1369)`, then `[salvage] eeae8feb … reset Todo` ×2 → `[fatal] cannot flip Done: readEvidence().kind === 'absent'` → `done_without_commit_evidence`, 0/4 phases — **with `allow_inferred_completion_commit=true` already set.**
- The Phantom-Done watcher meanwhile logged `kept ticket 4059a948/a4c721f2 Done — valid completion_commit evidence` (the two tickets given EXPLICIT `completion_commit:` frontmatter survived; the inferred-only one did not).

**Why inferred fails (R-CCRC):** inference still needs a commit *attributable to the ticket*. Pickle workers commit with human/LOA subjects (`feat: 1.C — … (LOA-1369)`) that contain **neither** the ticket dir-hash (`eeae8feb`) **nor** a `completion_commit:` frontmatter line. `hasCompletionCommit`'s attribution grep finds nothing → evidence "absent" → fatal, *even with the flag on*. This is exactly the [[R-CCRC]] "ticket-id grep misses R-code/LOA commits" gap.

**Consequence for operators/babysitters:** the ONLY reliable recovery is **explicit per-ticket back-fill**, and it **recurs once per ticket** in the bundle. Each phase-fatal: match the new commit to its ticket by the LOA/group ref in the subject (`eeae8feb`=LOA-1369=`1.C`, `d61fa934`=LOA-1370=`1.D`, …), stamp `completion_commit:<sha>` + `status:"Done"`, advance `current_ticket`, relaunch. A 6-ticket bundle ⇒ ~6 stop/back-fill/relaunch cycles. This makes hands-off autonomy impossible for any multi-ticket bundle on the claude backend until the worker writes `completion_commit` (or the gate attributes LOA/ref-code commits — the R-CCRC fix).

**Strengthened remediation priority:** remediation #1 (backend-agnostic worker `completion_commit` write) is the real unblocker; the R-CCRC attribution-grep widening (accept `(LOA-####)` / `feat: N.X` subjects) would also close it. The `allow_inferred` flag should NOT be advertised in the fatal message as a sufficient fix when the worker's own commit style defeats it.

### Compounding observation — salvage reaps in-progress async workers on larger tickets (cross-ref [[B-GNXR]])
On the relaunched run, ticket `14f134ca` (bigger: 2 tables + seed + resolver + module + tests) **salvage-looped 4× (~2-3 min cadence)** with 0-byte `worker_session_*.log` even though the worker WAS producing real artifacts (`research_20260620.md`, 7.1K, grounded file:line refs). Cause: the manager's normal *spawn-worker-async → yield turn → wait-to-be-woken* pattern lets the mux-runner **salvage the in-progress ticket at the iteration boundary** before the worker commits; the no-progress signal also appears to read `worker_session.log` size (0B, since the worker streams to the manager pane) rather than artifact production. The manager (opus-4-8) self-recovered by holding its turn open and **actively watching** the worker (no salvage for >6 min afterward). This is [[B-GNXR]]'s no-progress-discards-uncommitted-output class, recurring on the **claude** backend for large tickets — worth folding into that bundle's evidence.
