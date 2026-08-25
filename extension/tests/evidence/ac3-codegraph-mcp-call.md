# d2e342fe — AC-3 worker codegraph MCP-call evidence + measured tier baseline

Recorded 2026-08-25 on the `release/v2.1-beta` branch, commit `212ee432`.
Host: darwin arm64, node v24.19.0, `@colbymchenry/codegraph@0.9.9`.

Every number below was READ FROM THE RUNNER'S OWN SUMMARY BLOCK. Where a measurement
could not be completed it is recorded as NOT-MEASURED with the reason, never as a pass
(AC-B6: a measurement verdict records and continues; it never halts the run).

---

## AC-3 — a real codegraph MCP tool call that RETURNED A RESULT

Test: `extension/tests/integration/worker-codegraph-mcp-call-evidence.test.js`
(`@tier: integration`, serialized).

### Why `tools/list` was not already enough

The pre-existing real-surface suites (`codegraph-real-index.test.js` C0 `:168`, C7 `:236`)
drive `serve --mcp` only to `tools/list`. Measured here, that is insufficient in the exact
way this bundle is about: **`initialize` and `tools/list` both succeed against a working
directory where every `tools/call` fails.** A green handshake is not evidence the tool works.

The failure also does NOT arrive as a JSON-RPC error. It arrives as a well-formed `result`
with populated `content` and `isError: true` inside it. So both cheap assertions are
fake-green:

| Candidate assertion | True on the WORKING path | True on the BROKEN path |
|---|---|---|
| no JSON-RPC `error` came back | yes | **yes** |
| a `result` with non-empty `content` came back | yes | **yes** |
| `result.isError !== true` | yes | no |
| content names the indexed fixture symbol | yes | no |

Only the last two discriminate. AC-3's "absence of an error is not evidence of success" is
literally true at the wire level here — and its inverse is too.

### Durable evidence — log line emitted by the tier run itself

Captured from `npm run test:integration:serial` (`/tmp/int-ser.log`, this run):

```
[AC-3 evidence] codegraph MCP tools/call server=codegraph@0.9.9 tool=codegraph_search isError=false content_chars=93 matched_symbol=pickleAc3Helper
```

It records the POSITIVE facts — server identity, tool name, `isError=false`, the byte count
of returned content, and the symbol matched. It never records merely the absence of an error.

### Verbatim transcript — SUCCESS (indexed working dir)

The command is taken verbatim out of the `worker-mcp.json` that the production
`buildWorkerMcpConfig` materializes (`mcpServers.codegraph.args` tail = `["serve","--mcp"]`);
the bin is never re-derived, so the test cannot pass while the file a worker is handed
contains something else.

```
[index] files=1 nodes=3
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "## Search Results (1 found)\n\n### pickleAc3Helper (function)\nsrc/a.ts:1\n`(x: number): number`\n"
      }
    ]
  }
}
```

`isError` absent; content names the indexed fixture symbol. **The call returned a result.**

### Verbatim transcript — CONTROL (unindexed working dir)

```
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Error: Tool execution failed: No CodeGraph project is loaded for this session. ..."
      }
    ],
    "isError": true
  }
}
```

Same transport success, same populated `content` — and `isError: true`. This control is what
gives the success assertions their discriminating power; without it the success test would
prove only that a green path is green.

### Non-vacuity, mutation-verified

Removing the indexing step from the success test makes it FAIL at exactly the Layer-2
assertion — `AssertionError: tools/call result is not an MCP tool error` — while the control
still passes. The file was then restored byte-identical (`diff` clean) before commit.

---

## AC-7 — fast tier, `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`, clean environment

| Run | tests | pass | **fail** | **cancelled** | skipped | todo | rc | elapsed |
|---|---|---|---|---|---|---|---|---|
| 1 — ambient env (CONTAMINATED, discarded) | 8047 | 8038 | 3 | 0 | 5 | 1 | 1 | 199s |
| 2 — clean environment (**authoritative**) | 8047 | 8041 | **0** | **0** | 5 | 1 | 0 | 187s |

**AC-7 SATISFIED: `fail 0` AND `cancelled 0`.**

### The 3 failures in run 1 were environmental, not defects

This worker process runs with `PICKLE_TICKET_ID` and `GIT_CONFIG_COUNT` /
`GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` exported, which point `core.hooksPath` at the
session trailer hooks. Those hooks stamp `Pickle-Ticket: $PICKLE_TICKET_ID` into ANY commit
made in that environment — including commits made by test fixtures. The failures name it
directly:

```
tests/worker-timeout-preserves-commit.test.js
  AC-WDTFTO-1-1 / AC-WDTFTO-1-3
  actual:   [ 'd2e342fe' ]      <- THIS worker's ticket id
  expected: [ '4404d032' ]      <- the fixture's own ticket id
tests/services/backend-spawn-trailer-env.test.js
  backendEnvOverrides: materialization failure emits neither key and logs once
```

A ticket id cannot be substituted for another by any diff; this is the documented
`prds/BUG-2026-08-21-worker-env-stamps-test-fixture-commits.md` class. AC-7 specifies a clean
environment, so run 2 scrubbed the canonical `PICKLE_GATE_SCRUBBED_ENV_KEYS` set
(`services/pickle-utils.ts:182`) plus the indexed `GIT_CONFIG_KEY_<n>`/`VALUE_<n>` pairs.
Scrubbed, all three pass and the tier is `fail 0`.

### Re-flooring — this bundle's RECORDED baseline

The floor is computed dynamically at `extension/src/services/bundle-finalize.ts:124`
(`const floor = baseline + delta`) — it is **not** a hardcoded constant, so re-flooring means
recording a measured baseline, not editing a number. The PRD's `7720` is stale and the
`770dfe8a` "fast tier green" claim is NOT cited (it does not reproduce on this host).

| | tests | pass |
|---|---|---|
| ticket-stated bundle baseline | 8032 | 8025 |
| **measured this bundle (clean env)** | **8047** | **8041** |

`8047 >= 8032`. Delta `+15` over the stated baseline, of which `+2` are this ticket's own
tests (both land in the integration tier, so the fast-tier delta is from sibling tickets).

---

## AC-B5 — zero standing inherited-failure exceptions; the budget renders a verdict

Zero standing exceptions, confirmed on disk:

- `extension/tests/QUARANTINE.md` — schema comment only, **zero entries**.
- `extension/quarantine-baseline.json` — `{"initial_count": 0, "captured_at": "2026-05-03"}`.
- `bin/test-runner.js:31` `QUARANTINED_TIER_EXCLUSIONS = new Set(['fast','integration'])` —
  the exclusion mechanism exists, its input set is empty.

So any fast/integration failure is attributable, which is exactly what let run 1's three
failures above be traced to the environment rather than absorbed as a standing exception.

Verdict (previously `FAIL_BUDGET_EXCEEDED failures=3 budget=2`, unable to judge a tree
carrying a 100%-reproducible inherited failure):

```
flake-budget OK failures=0 budget=2 runs_completed=2 runs_requested=2      (rc=0, 343s)
```

**DISCLOSED REDUCTION:** this verdict is over **2 runs, not the script's default 5**
(`bin/check-flake-budget.js:5`). 5 full fast-tier runs is ~16 min of wall clock, past this
worker's foreground command ceiling, and backgrounding is forbidden (R-MWBG). The AC asks
whether the budget *can render a verdict* — it now can, and does, with zero failing runs.
A 5-run verdict remains un-taken and is recorded as such rather than implied.

---

## Fake-green trap #1 — integration halves run SEPARATELY

`package.json` `test:integration` is `test:integration:parallel && test:integration:serial`.
`&&` short-circuits, so a red parallel half leaves the serial half **unrun, not failed**. The
halves were therefore invoked as two independent commands, the serial one **regardless of the
parallel result**:

| Half | tests | pass | fail | cancelled | rc | elapsed |
|---|---|---|---|---|---|---|
| `test:integration:parallel` | 662 | 662 | 0 | 0 | 0 | 79s |
| `test:integration:serial` (at `212ee432`) | 617 | 617 | 0 | 0 | 0 | 477s |
| `test:integration:serial` (**final tree, `74e9d614`**) | **618** | 618 | 0 | 0 | 0 | 471s |

The serial half — the one `&&` can silently skip — was measured and is green. It was
re-measured after the simplify commit rather than letting the earlier number stand for code
that had since changed.

617 = the ticket's stated 615 plus this ticket's 2 new tests, confirming they ran there. The
final tree's 618 is one MORE, and the extra test is not a new file: `install-root-doc-invariant`
generates one assertion per documentation file mentioning `PICKLE_INSTALL_ROOT`, so committing
this artifact produced `ac3-codegraph-mcp-call.md:201 does not claim PICKLE_INSTALL_ROOT
overrides the install.sh prefix` — and it passes. Diffed the two runs' test-name lists to
establish that, rather than assuming the delta was noise. The `[AC-3 evidence]` line above was
emitted by both runs.

---

## Fake-green trap #2 — the soak did NOT self-skip

`test:expensive:serial` returns `rc=0 fail 0` in ~18s when the deploy-lifecycle soak refuses
to mutate `$HOME`. Run with `PICKLE_INSTALL_ROOT` on a non-`$HOME` path
(`/tmp/pickle-soak-root-D4SgRB`) and `RUN_EXPENSIVE_TESTS=1`:

```
✔ C0: real init/index/query surface matches PRD contracts on a populated fixture   (141ms)
✔ C0: empty-repo fixture yields 0 nodes / null with no throw                         (79ms)
✔ C0: serve --mcp stdio handshake (initialize -> tools/list) via absolute node bin  (157ms)
✔ C7: buildWorkerMcpConfig command drives a real serve --mcp handshake              (134ms)
✔ C0: committed inventory exists and its method surface matches the real class        (1ms)
✔ R-CGBOOT: CodegraphService.indexAll bootstraps a never-initialized dir             (96ms)
⚠ tests/integration/deploy-lifecycle-soak.test.js                          (598784.44ms)
ℹ pass 6   fail 0   cancelled 2
```

**The discriminator the ticket asks for: elapsed `598,784ms` (~599s), not ~18s.** The soak
genuinely engaged — an 18-second pass would have returned in the first seconds. Trap #2 is
disproved for this configuration.

**NOT-MEASURED-TO-COMPLETION — reason:** `deploy-lifecycle-soak.test.js:54` enforces
`SOAK_SECONDS >= 1800`, so a complete soak is ≥30 min. That exceeds this worker's foreground
command ceiling, and R-MWBG forbids backgrounding it. The run was terminated by that ceiling
at 599s; `cancelled 2` is that termination, not a test failure (`fail 0`). The soak's
skip-vs-real question is ANSWERED; its full-duration outcome is NOT, and is left for an
operator or CI run with a longer budget. Per AC-B6 this is recorded and the run continues.

The 6 expensive codegraph tests that DID complete all pass, including the C0/C7 handshake
suites this ticket's new test extends past `tools/list`.

---

## AC-B6 — no new halt surface

No new `exit_reason`, no new abort condition, no new halt path. The diff is one test file
plus two manifest entries; it adds no runtime branch. Both measurements that could not be
completed (the 5-run budget, the full soak) are recorded above with their reasons and did not
stop the ticket.
