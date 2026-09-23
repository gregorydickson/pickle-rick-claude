# B-CGUP-2 — the unindexed-call control pins a protocol flag `1.6.0` no longer sets

**Found by the release gate for B-CGUP** (run `20260923T032013Z-35839`, HEAD `4ffdc1c1`): 21/22 legs green,
soak 1803.7s, and ONE red: `test_integration`, serial half, 717/718.

```
✖ AC-3 control: the same call on an UNINDEXED working dir comes back isError
  tests/integration/worker-codegraph-mcp-call-evidence.test.js:245
  control call is flagged as an MCP tool error — actual undefined, expected true
```

## Measured, not inferred

- **`1.6.0` changed the reply shape, not the meaning.** A `codegraph_search` against the real `1.6.0`
  `serve --mcp` on an unindexed scratch repo (same env as production: `CODEGRAPH_NO_WATCH=1`,
  `CODEGRAPH_NO_DAEMON=1`) returns content beginning **"No CodeGraph project is loaded for this
  session."**, with **no `isError`**, and creates **no** `.codegraph/`. `0.9.9` set `isError: true`.
- **No production consumer of that flag exists.** `grep -rn isError extension/src` finds only three
  log readers and the circuit breaker, all reading stream-json `subtype`, not MCP tool results. The only
  readers of the MCP flag are this test and `tests/integration/fixtures/echo-mcp-server.js`.
- **Every real-surface `1.6.0` test passed in the same gate:** `C0` init/index/query, empty-repo, the
  `serve --mcp` handshake, `C7` worker MCP config handshake, and the inventory surface check.
- Standalone at HEAD: `node --test tests/integration/worker-codegraph-mcp-call-evidence.test.js` exits
  **1** (2 tests, 1 pass, 1 fail).

## The fix

Re-express the control against what STILL distinguishes an unindexed call, keeping it a real negative
control. The test's own comment says why it exists: without it, the success test "would be passing on a
call that cannot distinguish a working index from a missing one".

In `extension/tests/integration/worker-codegraph-mcp-call-evidence.test.js`, replace the single
`isError === true` assertion (`:245`) with:
1. the reply text does NOT contain the fixture symbol `pickleAc3Helper` (`FIXTURE_SYMBOL`, `:55`), and
2. the reply either has `isError === true` (`0.9.x` shape) OR its text states no project is loaded
   (match `/no codegraph project is loaded/i`). Both shapes mean "unindexed"; the version is not pinned.

Keep the transport-layer assertions above it (`reply.result` present, no JSON-RPC `error`, populated
`content`). Update the comment at `:241` ("only the protocol layer tells them apart"), which is no longer
true.

## Mutation Verification (BINDING, both directions)

1. Point the control at the INDEXED fixture used by the success test → the control goes RED (the symbol
   appears, and there is no "not loaded" text).
2. Drop assertion 1 and make assertion 2 accept any text → note that the control then passes on an
   indexed dir too (vacuous). Record both results in the conformance artifact.

## Acceptance Criteria

- `cd extension && node --test tests/integration/worker-codegraph-mcp-call-evidence.test.js` exits `0` — **measured `1` at HEAD `4ffdc1c1`**.
- `grep -c "assert.equal(reply.result.isError, true" extension/tests/integration/worker-codegraph-mcp-call-evidence.test.js` returns `0` — **measured `1`**. (Anchored on `assert.equal`: the bare substring also matches the SUCCESS test's `assert.notEqual(reply.result.isError, true` at `:190`, which must stay, so an unanchored count could never reach 0.)
- The control's title (`:216`, "comes back isError") and the header comment (`:13`) are reworded to say "reports no loaded project", not "isError".
- `grep -c 'no codegraph project is loaded' extension/tests/integration/worker-codegraph-mcp-call-evidence.test.js` returns a value `>= 1` — **measured `0`**.

## Simplification Review

1. **Necessary?** Yes: it is the only red blocking B-CGUP's ship.
2. **Reuse?** It reuses the existing fixture, helpers and success test; no new file.
3. **Brittle complexity?** The brittleness was pinning a protocol flag upstream could change. The fix
   asserts meaning (no match, "not loaded") instead.
4. **Subtraction?** None available; it is a one-assertion reshape.

## Non-goals

No change to `src/`. Do not delete the control. Do not pin a codegraph version in the test.
