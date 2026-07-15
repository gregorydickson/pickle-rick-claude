---
title: "R-RWNF — the review-worker path is confirmed never-fired, but it is woven through the worker-spawn CORE (not a tiny delete)"
finding: R-RWNF
priority: P3
status: open
type: bug-report
schema_neutral: true
surfaced: "2026-07-14 (B-FOMC deferred-surfaces enumeration); verified dead + scoped 2026-07-15 during the babysitter drain loop."
routing: "SUBTRACTIVE removal, but ATTENDED — it excises a code path from spawn-morty.ts (the worker-spawn core, trap-door-dense). Do NOT rush it autonomously; a wrong cut breaks worker spawning for EVERY build."
---

# R-RWNF — dead, confirmed, but not a one-line delete

## Verification (2026-07-15 — the "is it really dead?" step, done before any removal)

**Confirmed: no production caller passes `--review` to spawn-morty.** Grepped `extension/src/` + `.claude/`:
the only consumer is `spawn-morty.ts:421` (`isReviewTicket: argv.includes('--review')`); nothing in
`mux-runner.ts`, `pipeline-runner.ts`, or any `.claude/commands/*.md` passes the flag. (The `--review-provider`
hits in `pickle-dot*.md` are an unrelated attractor flag, not this.) So the review-worker path **is** dead on the
autonomous path, exactly as the B-FOMC deferred-surfaces note recorded.

## Why it is NOT the tiny subtraction the drain-queue row implies

`isReviewTicket` is woven through the worker-spawn **core** — `extension/src/bin/spawn-morty.ts` at **8 sites**:
`:81`, `:91` (interface fields), `:421` (parse), `:932` (prompt-file selection → `send-to-morty-review.md`),
`:938`, `:943` (prompt assembly branches), `:2330` (role = 'review' vs 'implementation'), `:2531` (phase branch).
Plus references in **5 test files** (`spawn-morty.test.js`, `template-no-bare-tokens.test.js`,
`send-to-morty-resume.test.js`, `fom-infusion-prompts.test.js`'s EXCLUDED list, and the promise-token tests) and
doc-comments in `types/index.ts:563` + `promise-tokens.ts:15`, and the command file `.claude/commands/send-to-morty-review.md`.

Removing it means excising a branch that interleaves with the LIVE implementation path in the worker-spawn core.
`spawn-morty.ts` is the file every build's worker runs through, and it is trap-door-dense. A subtle mis-cut (e.g.
removing a branch the implementation path also reaches) breaks worker spawning for **all** builds — the opposite of
the reliability the north-star prioritizes.

## The fix (attended, subtractive)

1. Read all 8 `isReviewTicket` sites; confirm each branch's `false`/implementation arm is the ONLY one the live
   path needs, and that removing the `true` arm changes nothing on the implementation path.
2. Excise `isReviewTicket` + the `--review` parse + the `send-to-morty-review.md` prompt-selection branch + the
   `role: 'review'` distinction. Delete `.claude/commands/send-to-morty-review.md`.
3. Update the 5 test files (drop the review-path cases; keep `fom-infusion-prompts.test.js`'s EXCLUDED list
   consistent — the entry can go once the surface is gone) and the doc-comments in `types/index.ts` /
   `promise-tokens.ts`.
4. Full release gate on a quiet box; `bash install.sh`; verify the implementation path is unaffected.

## Acceptance criteria

- `AC-RWNF-1`: `grep -rn "isReviewTicket\|--review\b\|send-to-morty-review" extension/src/ .claude/` returns
  **zero** hits (path fully excised; `--review-provider` in pickle-dot is a different token and is out of scope).
- `AC-RWNF-2`: full release gate green; worker spawns unaffected (an implementation-ticket build still runs).

## Simplification Review

1. **Necessary?** Pure removal — the ideal. It deletes a never-fired capability.
2. **Reuse vs add?** N/A (deletion).
3. **Guards brittle complexity?** It removes a dead branch from the worker core, flattening it.
4. **Subtracts?** A whole prompt file + a flag + ~8 branch sites + 5 test cases.

## Related

- B-FOMC deferred-surfaces (`send-to-morty-review.md` — "disposal belongs to R-RWNF").
- [[project_dead_code_scaffolding_silent_death_handbuild]] — the memory on why dead-code removal in the worker
  core needs call-site care, not just a compile check.
