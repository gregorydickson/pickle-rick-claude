/**
 * Killable subprocess boundary for the spawn-path codegraph queries (AC-CGH-A1).
 *
 * The upstream `@colbymchenry/codegraph` SDK's `searchNodes`/`getCallers` are
 * SYNCHRONOUS native calls (see `extension/data/codegraph-api-inventory.json`), so an
 * in-process `Promise.race` can never preempt a wedged call — a hang blocks the whole
 * `spawn-morty` process and burns a worker-timeout iteration. This module runs the
 * batch of queries for ONE section build in a `detached` child process and group-kills
 * it on timeout via the shared negative-PID primitive (`killProcessGroup`). The vendored
 * bin is a shim that spawns the platform binary as a GRANDCHILD; a plain child `timeout`
 * kills the shim and leaks the wedged native binary, so the child leads its own process
 * group and we signal the WHOLE group.
 *
 * The child imports the SDK in-process (init()/open() do NOT auto-watch per the
 * inventory), defensively sets `CODEGRAPH_NO_WATCH=1`, executes every query in ONE
 * invocation, and returns JSON preserving the `SearchResult={node,score}` shape the
 * consumer (`collectCodegraphHits`) expects.
 *
 * This file is BOTH the parent runner API and the child entry — the CLI guard at the
 * bottom runs the child when the module is spawned as `node codegraph-query-runner.js`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessGroup } from './orphan-reaper.js';

/** One FTS hit, `{node,score}` shape preserved from `SearchResult`. */
export interface CodegraphSearchHit {
  node: unknown;
  score: number;
}

/** Batched query request for one section build: search terms + caller node ids. */
export interface CodegraphQueryBatchInput {
  workingDir: string;
  searches: string[];
  callers: string[];
}

export interface CodegraphQueryBatchOk {
  status: 'ok';
  searches: Record<string, CodegraphSearchHit[]>;
  callers: Record<string, unknown[]>;
}
export interface CodegraphQueryBatchTimeout {
  status: 'timeout';
  reason: string;
}
export interface CodegraphQueryBatchFailed {
  status: 'failed';
  reason: string;
}
export type CodegraphQueryBatchResult =
  | CodegraphQueryBatchOk
  | CodegraphQueryBatchTimeout
  | CodegraphQueryBatchFailed;

export interface RunCodegraphQueryBatchOpts {
  /** Per-batch wall bound. The child is group-killed once it elapses. */
  timeoutMs: number;
  /** Override the spawned child entry (tests). Defaults to this compiled module. */
  childScriptPath?: string;
  /** Environment for the child (tests / kill-switch forwarding). */
  env?: NodeJS.ProcessEnv;
  /** Injectable spawner (tests). Defaults to `child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Injectable group-killer (tests). Defaults to `killProcessGroup`. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => boolean;
}

/** Grace between the group SIGTERM and the escalating group SIGKILL. */
const GROUP_KILL_GRACE_MS = 2000;

/** Compiled path of THIS module — the default child entry we spawn. */
function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * Run a batch of codegraph queries in a killable `detached` child. Never throws;
 * returns a discriminated result. On timeout the child's whole process group is
 * signalled (SIGTERM → grace → SIGKILL) so a wedged native grandchild cannot leak.
 */
export async function runCodegraphQueryBatch(
  input: CodegraphQueryBatchInput,
  opts: RunCodegraphQueryBatchOpts,
): Promise<CodegraphQueryBatchResult> {
  const kill = opts.killGroup ?? killProcessGroup;
  const spawnFn = opts.spawnFn ?? spawn;
  const childPath = opts.childScriptPath ?? selfPath();

  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [childPath], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(opts.env ?? process.env), CODEGRAPH_NO_WATCH: '1' },
    });
  } catch {
    return { status: 'failed', reason: 'spawn-threw' };
  }

  return new Promise<CodegraphQueryBatchResult>((resolve) => {
    let settled = false;
    let stdout = '';

    const settle = (result: CodegraphQueryBatchResult): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) { return; }
      const pid = child.pid;
      if (typeof pid === 'number') {
        // Group-kill the leader: SIGTERM, then escalate to SIGKILL after a grace
        // window so a native call that ignores SIGTERM cannot linger.
        kill(pid, 'SIGTERM');
        const escalate = setTimeout(() => {
          // `child.killed` reflects only whether `child.kill()` was called — this module
          // group-kills via `kill(pid, ...)` and never touches it, so `!child.killed` was
          // always true (dead sub-term). The live guard is `exitCode === null`: skip the
          // escalation only if the child already exited with a real code.
          if (child.exitCode === null) { kill(pid, 'SIGKILL'); }
        }, GROUP_KILL_GRACE_MS);
        if (typeof escalate.unref === 'function') { escalate.unref(); }
      }
      settle({ status: 'timeout', reason: 'grandchild-kill' });
    }, opts.timeoutMs);
    if (typeof timer.unref === 'function') { timer.unref(); }

    // `setEncoding` before the first read, NOT a per-chunk decode: an OS pipe boundary is a
    // BYTE offset, so a multi-byte UTF-8 character straddles it and `String(chunk)` turns
    // each half into U+FFFD. The result still parses (U+FFFD is legal inside a JSON string),
    // so the corruption is silent. `setEncoding` runs the stream through a StringDecoder,
    // which holds a partial sequence back until its continuation bytes arrive. Same shape the
    // sibling readers in `spawn-morty.ts` and `microverse-runner.ts` already use.
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    // Drain stderr so a chatty child can't deadlock on a full pipe buffer; the content
    // itself is not surfaced (failures are classified by exit code / stdout parseability).
    child.stderr?.on('data', () => {});

    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({ status: 'failed', reason: err.code === 'ENOENT' ? 'enoent' : 'spawn-error' });
    });

    child.on('close', (code) => {
      if (settled) { return; } // timeout already fired — swallow the late close
      if (code !== 0) {
        settle({ status: 'failed', reason: `shim-exit-${code ?? 'null'}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as Partial<CodegraphQueryBatchOk>;
        settle({
          status: 'ok',
          searches: parsed.searches ?? {},
          callers: parsed.callers ?? {},
        });
      } catch {
        settle({ status: 'failed', reason: 'unparseable-stdout' });
      }
    });

    // Best-effort: hand the batch to the child. A dead child yields EPIPE.
    //
    // The sync try/catch is NOT sufficient on its own. `child.stdin` is a stream: a write
    // larger than the OS pipe buffer (a batch of search terms easily is) is buffered and
    // flushed on a later tick, so a pipe that breaks after the call returns surfaces as an
    // asynchronous 'error' event — and an unhandled stream 'error' is an uncaught exception
    // that kills the PARENT (spawn-morty), not the child. Same two-arm shape as
    // `writeChildInput` in hooks/dispatch.ts, which registers the listener for exactly this
    // reason (pinned by the PC-1/PC-2 split in tests/integration/process-cleanup.test.js).
    // No kill needed here: the timeout group-kills, and 'close'/'error' on the ChildProcess
    // settles the promise.
    child.stdin?.on('error', () => { /* child already gone — close/error handler settles */ });
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch { /* child already gone — close/error handler settles */ }
  });
}

// --- Child entry ------------------------------------------------------------
//
// Spawned as `node codegraph-query-runner.js`. Reads the batch from stdin, runs the
// SDK queries in-process (no watcher), and writes `{searches,callers}` JSON to stdout.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

interface ChildGraph {
  searchNodes(query: string): unknown;
  getCallers(nodeId: string): unknown;
  close?(): void;
}

async function runChild(): Promise<void> {
  process.env.CODEGRAPH_NO_WATCH = '1';
  const raw = await readStdin();
  const input = JSON.parse(raw) as CodegraphQueryBatchInput;

  const mod = (await import('@colbymchenry/codegraph')) as Record<string, unknown>;
  const bag = (mod.default as Record<string, unknown> | undefined) ?? mod;
  const CodeGraph = bag.CodeGraph as
    | { open?: (root: string) => Promise<unknown>; init?: (root: string) => Promise<unknown> }
    | undefined;
  if (!CodeGraph) { throw new Error('CodeGraph unavailable'); }
  const graph = (CodeGraph.open
    ? await CodeGraph.open(input.workingDir)
    : await CodeGraph.init?.(input.workingDir)) as ChildGraph | null;
  if (!graph) { throw new Error('graph open failed'); }

  const searches: Record<string, CodegraphSearchHit[]> = {};
  for (const term of input.searches ?? []) {
    const r = graph.searchNodes(term);
    searches[term] = Array.isArray(r)
      ? r.map((x) => {
          const rec = (x ?? {}) as Record<string, unknown>;
          const node = 'node' in rec ? rec.node : x;
          const score = typeof rec.score === 'number' ? rec.score : 0;
          return { node, score };
        })
      : [];
  }

  const callers: Record<string, unknown[]> = {};
  for (const id of input.callers ?? []) {
    const c = graph.getCallers(id);
    callers[id] = Array.isArray(c) ? c : [];
  }

  try { graph.close?.(); } catch { /* release best-effort */ }
  // Flush stdout BEFORE the deterministic exit. `process.stdout.write` to the parent's
  // pipe is async once the payload exceeds the OS pipe buffer (~64KB), so a bare
  // `process.exit(0)` truncates the un-drained tail — the parent's `JSON.parse(stdout)`
  // then throws and the whole batch degrades to `unparseable-stdout` on large result
  // sets. The write callback fires only after the payload is handed to the OS, so a big
  // batch round-trips intact. The explicit exit is still required: the SDK can leave a
  // handle open, so a natural exit would look like a false timeout to the parent.
  // This is a CLI child entry (guarded below), not library code.
  process.stdout.write(JSON.stringify({ searches, callers }), () => {
    // eslint-disable-next-line pickle/no-process-exit-in-library
    process.exit(0);
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'codegraph-query-runner.js') {
  runChild().catch((err: unknown) => {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    // eslint-disable-next-line pickle/no-process-exit-in-library
    process.exit(1);
  });
}
