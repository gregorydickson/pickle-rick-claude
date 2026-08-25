// @tier: integration
// SERIAL: spawns a real `codegraph serve --mcp` child and drives a full JSON-RPC
// tool call; the sibling handshake suite records that this exact child flakes under
// tier concurrency (tests/integration/codegraph-real-index.test.js:2), so this file
// is listed in tests/integration/.serial-tests.json.
//
// d2e342fe AC-3 — prove a worker makes a REAL codegraph MCP call that RETURNS A RESULT.
//
// Why this file exists even though C0/C7 already drive `serve --mcp`:
// those suites stop at `tools/list`. Measured on this tree, `initialize` and
// `tools/list` BOTH succeed against a working directory where every `tools/call`
// fails — so a green handshake is not evidence the tool works. Worse, the failure
// arrives as a well-formed `result` carrying populated `content` with `isError: true`
// riding inside it. That means BOTH cheap assertions are fake-green:
//   - "no JSON-RPC error came back"  → true on the broken path
//   - "a result with content came back" → also true on the broken path
// AC-3's rule ("the absence of an error is not evidence of success") is therefore
// literally true at the wire level, and its inverse is too. The success test below
// asserts three independent layers, and the negative control pins the broken shape
// so the success assertions are provably able to tell the two apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildWorkerMcpConfig } from '../../services/backend-spawn.js';

const require = createRequire(import.meta.url);
const TEST_TIMEOUT_MS = 240_000;
const CALL_TIMEOUT_MS = 120_000;

// The programmatic API and the `serve --mcp` bin both live behind a per-platform
// optionalDependency of the codegraph package. When that bundle genuinely is not
// installed the feature cannot work at all and there is nothing to measure — that is
// the ONLY skip this file permits. Every other error propagates: a resolve failure of
// `@colbymchenry/codegraph` itself is a real failure, because it is a hard `dependencies`
// entry of extension/package.json and is present on any host that ran `npm ci`.
function loadCodeGraphOrSkipReason() {
  try {
    return { mod: require('@colbymchenry/codegraph'), skip: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/platform bundle|is not installed|not available because/i.test(msg)) {
      return { mod: null, skip: `platform bundle not installed: ${msg.split('\n')[0]}` };
    }
    throw err;
  }
}

function makeFixture(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Materialize the worker MCP config through PRODUCTION code and return the codegraph
// server entry verbatim. Deliberately does NOT re-derive the bin path: driving a
// re-derived command would keep passing while the file a worker is actually handed
// contained something else, which is the very gap AC-3 closes.
function materializeWorkerCodegraphEntry(workingDir) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ac3-session-'));
  const mcpPath = buildWorkerMcpConfig(sessionDir, workingDir, { expose_mcp_to_workers: true }, null);
  assert.ok(mcpPath, 'buildWorkerMcpConfig returned a session config path');
  assert.ok(fs.existsSync(mcpPath), `materialized worker MCP config exists at ${mcpPath}`);
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.codegraph;
  assert.ok(entry, 'materialized config carries an mcpServers.codegraph entry');
  assert.deepEqual(entry.args.slice(-2), ['serve', '--mcp'], 'materialized args end with serve --mcp');
  return { entry, sessionDir };
}

// initialize -> notifications/initialized -> tools/call, over the child's stdio.
// Resolves with the RAW JSON-RPC reply so each test asserts its own layers; a
// helper that pre-judged success/failure would hide the exact distinction under test.
function mcpToolCall(entry, toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      cwd: entry.cwd,
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Hang guard at the spawn itself, in addition to the settle-timer below:
      // the timer guarantees the PROMISE settles, this guarantees the CHILD dies
      // even if the timer never runs. Well above the audit's 30s floor.
      timeout: CALL_TIMEOUT_MS,
    });
    let buf = '';
    let initResult = null;
    let stage = 0;
    // Hang guard: an unbounded stdio wait is the one way this test could stall the
    // serial half, so the child is always killed and the promise always settles.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      reject(new Error(`codegraph MCP call timed out after ${CALL_TIMEOUT_MS}ms (stage ${stage})`));
    }, CALL_TIMEOUT_MS);
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    const finish = (fn) => {
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      fn();
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && stage === 0) {
          stage = 1;
          initResult = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
        } else if (msg.id === 2) {
          finish(() => resolve({ initResult, reply: msg }));
          return;
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pickle-worker-ac3', version: '0.0.0' },
      },
    });
  });
}

test('AC-3: a worker codegraph MCP tools/call returns a real result', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { mod, skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);
  const { CodeGraph } = mod;

  const workingDir = makeFixture('cg-ac3-indexed-', {
    'src/a.ts':
      'export function pickleAc3Helper(x: number): number { return x + 1; }\n'
      + 'export function pickleAc3Main(): number { return pickleAc3Helper(41); }\n',
  });
  let sessionDir = null;
  try {
    // Index first. Without this assertion a silently-empty index would make the
    // semantic assertion below fail for the wrong reason and read as a feature break.
    const cg = await CodeGraph.init(workingDir);
    const idx = await cg.indexAll();
    cg.close();
    assert.equal(idx.success, true, 'fixture indexAll succeeded');
    assert.ok(idx.nodesCreated > 0, 'fixture index produced nodes (index is not silently empty)');

    const materialized = materializeWorkerCodegraphEntry(workingDir);
    sessionDir = materialized.sessionDir;
    const { initResult, reply } = await mcpToolCall(
      materialized.entry,
      'codegraph_search',
      { query: 'pickleAc3Helper', limit: 5 },
    );

    assert.ok(initResult && initResult.serverInfo, 'initialize returned serverInfo');

    // Layer 1 — transport: a reply arrived, and it is a result rather than a
    // JSON-RPC error object.
    assert.ok(reply.result, 'tools/call returned a JSON-RPC result');
    assert.equal(reply.error, undefined, 'tools/call returned no JSON-RPC error');

    // Layer 2 — protocol: MCP signals tool-level failure INSIDE a well-formed
    // result. This is the assertion the handshake suites do not make, and the one
    // that separates "the server answered" from "the tool worked".
    assert.notEqual(reply.result.isError, true, 'tools/call result is not an MCP tool error');

    // Layer 3 — semantic: the payload is a real answer about the fixture, not a
    // generic banner that happens to be shaped like content.
    assert.ok(Array.isArray(reply.result.content), 'result.content is an array');
    assert.ok(reply.result.content.length > 0, 'result.content is non-empty');
    const text = reply.result.content.map((c) => c.text || '').join('\n');
    assert.ok(
      text.includes('pickleAc3Helper'),
      `result names the indexed fixture symbol; got: ${text.slice(0, 300)}`,
    );

    // AC-3 durable evidence: a log line showing the call RETURNED A RESULT, captured
    // in the test runner's own output. Records the positive facts (isError=false plus
    // the matched symbol), never merely the absence of an error.
    process.stdout.write(
      `[AC-3 evidence] codegraph MCP tools/call server=${initResult.serverInfo.name}@${initResult.serverInfo.version} `
      + `tool=codegraph_search isError=${reply.result.isError === true} content_chars=${text.length} `
      + `matched_symbol=pickleAc3Helper\n`,
    );
  } finally {
    rmDir(workingDir);
    if (sessionDir) rmDir(sessionDir);
  }
});

test('AC-3 control: the same call on an UNINDEXED working dir comes back isError', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { skip } = loadCodeGraphOrSkipReason();
  if (skip) return t.skip(skip);

  // Non-vacuity control. If this call also came back clean, the success test above
  // would prove nothing — it would be passing on a call that cannot distinguish a
  // working index from a missing one. Asserting the BROKEN shape here is what gives
  // the success assertions their discriminating power.
  const workingDir = makeFixture('cg-ac3-unindexed-', {
    'src/a.ts': 'export function pickleAc3Helper(x: number): number { return x + 1; }\n',
  });
  let sessionDir = null;
  try {
    assert.ok(
      !fs.existsSync(path.join(workingDir, '.codegraph')),
      'control fixture genuinely has no .codegraph index',
    );
    const materialized = materializeWorkerCodegraphEntry(workingDir);
    sessionDir = materialized.sessionDir;
    const { reply } = await mcpToolCall(
      materialized.entry,
      'codegraph_search',
      { query: 'pickleAc3Helper', limit: 5 },
    );

    // The transport layer still succeeds here — that is the whole point.
    assert.ok(reply.result, 'control still returns a well-formed JSON-RPC result');
    assert.equal(reply.error, undefined, 'control returns no JSON-RPC error either');
    assert.ok(Array.isArray(reply.result.content) && reply.result.content.length > 0,
      'control still returns populated content');
    // ...and only the protocol layer tells them apart.
    assert.equal(reply.result.isError, true, 'control call is flagged as an MCP tool error');
  } finally {
    rmDir(workingDir);
    if (sessionDir) rmDir(sessionDir);
  }
});
