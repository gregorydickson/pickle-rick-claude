> **✅ SHIPPED 2026-08-25 in v2.1.0-beta.17 ([[B-CGSHIP]] ticket `942ab116`) — CLOSED.**
> Re-verified at HEAD: `tests/install-bun-probe.test.js` → **rc=0, pass 5, fail 0** (was `fail 1`).
> The probe now resolves bun via `command -v` instead of substring-matching PATH, plus a hang-guard
> timeout on the `spawnSync`. This was one of the two standing inherited-failure exemptions; both are
> now retired and the release gate is green with ZERO waived failures.

> **⚠️ BLAST RADIUS IS WIDER THAN THIS PRD DESCRIBES — measured 2026-08-23 by the closer ticket of the
> P0 MCP bundle (session `2026-08-23-6fa67c68`, ticket `ff010489`).** This PRD names 2 failing tests.
> The measured count on this host is **~9**, and the extra ones fail for a second reason that matters
> more than the banner assertions.
>
> Because bun 1.3.2 really is installed at `/opt/homebrew/bin/bun`, the hang-guard tests that assume
> bun is ABSENT now spawn the REAL binary instead of hitting their guard against a nonexistent one.
> Their durations go from milliseconds to minutes:
>
> | test | observed duration |
> |---|---|
> | `bun probe emits banner when bun is absent` | 20–40 ms (direct assertion) |
> | `install.sh bun probe` | 17–54 ms (direct assertion) |
> | `grep hang is bounded by findImportersTimeoutMs` | 61,090 ms |
> | `computeOneHop import walks` | 103,387 / 1,035,730 ms |
> | `guardRereadBackoffMs: R-CCR-9 env above 5000ms ceiling clamped` | 187,208 ms |
> | `hung \`bun --version\` exits non-zero within BUN_TIMEOUT_MS + slack` | 211,902 ms |
> | `plumbus-frame-analyzer — bun hang guard` | 242,118 / 1,013,562 ms |
> | `hung \`bun dump-graph.ts\` exits non-zero within BUN_TIMEOUT_MS + slack` | 983,479 ms |
> | `rg hang is bounded by findImportersTimeoutMs` | 993,476 ms |
>
> **Consequences the 2-test framing hides:**
> 1. `npm run test:fast:budget` FAILS (`FAIL_BUDGET_EXCEEDED failures=3 budget=2`) because each rerun
>    gets slower, not merely because two assertions fail.
> 2. A single idle-box `npm run test:fast` still reports **fail 1** (measured twice: 7872 tests before
>    the bundle, 7938 after). So the tier looks nearly clean when idle and degrades badly under load —
>    which is why the "green tree" baseline is condition-dependent and must be recorded, not assumed.
> 3. This is the likely explanation for at least one long 0-CPU `test-runner` observation that would
>    otherwise read as an R-TIERWEDGE hang.
>
> Full evidence: `ff010489/conformance_2026-08-23.md` in that session.

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
