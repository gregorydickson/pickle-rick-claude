# BUG REPORT — worker handoff-notes continuity has no enforcement/fallback; a spawn that runs out of turns mid-verification loses all progress memory for the next spawn

**Filed:** 2026-07-05 (forensics review of session `2026-07-04-4f50b896`, ticket `43e8f1a9`)
**Code:** R-HNCG (Handoff-Notes Continuity Gap)
**Priority:** P3 (efficiency; no data loss/false-completion — commit-and-continue salvaged the real diff)
**Component:** Worker prompt (`.claude/commands/send-to-morty.md`, `extension/src/bin/spawn-morty.ts:buildWorkerPrompt`), ticket-dir `handoff_notes.md` convention

## Symptom (observed)

Ticket `43e8f1a9` (audit ticket, codex backend, session `2026-07-04-4f50b896`) went through 6 spawns
before landing a commit. `worker_artifact_progress.43e8f1a9` recorded 6 consecutive zero-delta spawns.
Only ONE of the 6 spawns hit an actual tool error (`apply_patch verification failed`, spawn 2,
self-corrected). The rest show the worker doing real, escalating verification work — reading test
files (spawns 3-5), then actually running the real test suite and passing it 262/262 (spawn 6), with
the accumulated diff growing to 38 files by that point — yet none of it produced a written artifact
or commit. `commit-and-continue` (R-ORSR-2) eventually salvaged the accumulated green diff from the
stash.

## Root cause

The worker prompt (`spawn-morty.ts:buildWorkerPrompt` + `.claude/commands/send-to-morty.md`)
instructs, under "Session Knowledge Transfer": read `${TICKET_DIR}/handoff_notes.md` at the start of a
spawn to avoid repeating prior work, and "Before you finish," append a 5-line entry to it. This is the
ONLY mechanism carrying verification progress between spawns (each spawn is a fresh, stateless CLI
invocation — nothing survives except ticket-dir files and the git diff itself).

**`43e8f1a9/handoff_notes.md` does not exist** — none of the 6 spawns wrote it. Spawn 48522's log (the
one where the real test suite passed) ends immediately after the passing result with no further
narration at all, consistent with running out of turns before ever reaching its own "before you
finish" checklist.

Because the continuity file was never populated, every spawn started blind — with no memory that a
prior spawn had already confirmed 3 of 4 acceptance criteria and was partway through the 4th (the slow
migration suite). Each spawn had to re-derive its own confidence from scratch by re-reading code and
re-running tests, which is consistent with the escalating-but-never-concluding pattern observed (5
diff hunks → 38 → 6 across the visible `git diff` output in later spawns).

There is no fallback for this: `handoff_notes.md` is written ONLY as a "before you finish" step with
no earlier, forced checkpoint, so a spawn that runs out of turns mid-verification (which
audit/verification-heavy tickets are structurally prone to, having no natural "I've made an edit, let
me pause" moment the way implement-phase work does) loses everything.

## Impact

Any verification-heavy ticket (audits, integration-heavy fixes, anything with a slow
acceptance-criteria command) is at risk of repeated from-scratch re-verification across spawns with no
memory of prior confirmed ACs, burning real wall-clock/worker-quota. The eventual outcome was still
correct here (commit-and-continue salvaged it), but the cost is silent and cumulative — nothing
currently surfaces "handoff_notes.md was never written for N spawns in a row" as a signal.

## Fix direction (subtract-before-add)

Reuse the existing mechanism rather than adding a new one:
1. Make the "before you finish" handoff-notes write a **forced early checkpoint** rather than a final
   step — e.g., instruct the worker to write/update `handoff_notes.md` immediately after EACH
   acceptance-criterion it confirms (not just once at the very end of a spawn), so a spawn that runs
   out of turns mid-verification still leaves a partial trail.
2. Alternatively (cheaper, no prompt-behavior dependency): have spawn-morty itself detect a
   zero-artifact spawn on exit (this signal already exists — `worker_artifact_progress`) and
   mechanically append a minimal note to `handoff_notes.md` — "no artifact/commit from this spawn; git
   diff at exit: `<numstat summary>`" — so the NEXT spawn's prior-context read at least sees that a
   diff existed, even if the model itself never wrote proper notes.

Either direction reuses `worker_artifact_progress` (already tracked) and the existing
`handoff_notes.md` read/write convention — no new state field, gate, or flag.

## Acceptance criteria (for the eventual fix)

- [ ] A repro fixture (worker spawn that runs out of turns mid-verification, real diff present, no
      `handoff_notes.md` written) demonstrates the next spawn receives SOME continuity signal (either a
      real note or a mechanically-appended fallback note) rather than starting fully blind.
- [ ] No new state field/gate/flag — reuses `worker_artifact_progress` + `handoff_notes.md`.
- [ ] Existing worker-prompt tests unaffected; new test added for the fallback-note path if (2) is
      chosen.
