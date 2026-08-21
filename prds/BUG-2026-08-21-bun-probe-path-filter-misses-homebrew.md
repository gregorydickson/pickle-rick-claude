# BUG-2026-08-21 (P3) — the bun probe's PATH-scrub heuristic misses Homebrew

## Status
Open. Split out of `BUG-2026-08-20` as a NON-GOAL (test-isolation defect, unrelated signature).

## What happens
`extension/tests/install-bun-probe.test.js` test 2, *"bun probe emits banner when bun is absent"*,
simulates absence by dropping `PATH` entries whose path string contains `"bun"` or `".bun"`. That
matches `~/.bun/bin` but NOT Homebrew's `/opt/homebrew/bin`. Measured on the operator box: the filter
removes **zero** entries, bun 1.3.2 is still found, no degraded-mode banner is emitted, test fails.

The test therefore passes only on machines where bun is absent or installed under a `bun`-named
directory — it asserts a property of the host, not of the installer.

## Acceptance criteria
- **AC-1** The absence simulation is deterministic regardless of where bun is installed — resolve
  `command -v bun` and remove THAT directory, or run the probe under a minimal constructed `PATH`.
- **AC-2** The test passes with bun installed AND with bun absent.
- **AC-3** No production code changes; test-only.

## Non-goals
Uninstalling bun. Changing the installer's probe itself (it is correct).

## Simplification Review
1. **Necessary?** Test-only correction.
2. **Reuse?** Prefer an existing PATH-scrub helper if one exists.
3. **Guards brittle complexity?** It REPLACES a brittle substring heuristic with a resolved path.
4. **Subtracts?** A host-dependent assertion masquerading as a behavioural one.
