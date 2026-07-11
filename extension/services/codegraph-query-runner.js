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
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessGroup } from './orphan-reaper.js';
/** Grace between the group SIGTERM and the escalating group SIGKILL. */
const GROUP_KILL_GRACE_MS = 2000;
/** Compiled path of THIS module — the default child entry we spawn. */
function selfPath() {
    return fileURLToPath(import.meta.url);
}
/**
 * Run a batch of codegraph queries in a killable `detached` child. Never throws;
 * returns a discriminated result. On timeout the child's whole process group is
 * signalled (SIGTERM → grace → SIGKILL) so a wedged native grandchild cannot leak.
 */
export async function runCodegraphQueryBatch(input, opts) {
    const kill = opts.killGroup ?? killProcessGroup;
    const spawnFn = opts.spawnFn ?? spawn;
    const childPath = opts.childScriptPath ?? selfPath();
    let child;
    try {
        child = spawnFn(process.execPath, [childPath], {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...(opts.env ?? process.env), CODEGRAPH_NO_WATCH: '1' },
        });
    }
    catch {
        return { status: 'failed', reason: 'spawn-threw' };
    }
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            if (settled)
                return;
            const pid = child.pid;
            if (typeof pid === 'number') {
                // Group-kill the leader: SIGTERM, then escalate to SIGKILL after a grace
                // window so a native call that ignores SIGTERM cannot linger.
                kill(pid, 'SIGTERM');
                const escalate = setTimeout(() => {
                    if (!child.killed && child.exitCode === null)
                        kill(pid, 'SIGKILL');
                }, GROUP_KILL_GRACE_MS);
                if (typeof escalate.unref === 'function')
                    escalate.unref();
            }
            settle({ status: 'timeout', reason: 'grandchild-kill' });
        }, opts.timeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        // Drain stderr so a chatty child can't deadlock on a full pipe buffer; the content
        // itself is not surfaced (failures are classified by exit code / stdout parseability).
        child.stderr?.on('data', () => { });
        child.on('error', (err) => {
            settle({ status: 'failed', reason: err.code === 'ENOENT' ? 'enoent' : 'spawn-error' });
        });
        child.on('close', (code) => {
            if (settled)
                return; // timeout already fired — swallow the late close
            if (code !== 0) {
                settle({ status: 'failed', reason: `shim-exit-${code ?? 'null'}` });
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                settle({
                    status: 'ok',
                    searches: parsed.searches ?? {},
                    callers: parsed.callers ?? {},
                });
            }
            catch {
                settle({ status: 'failed', reason: 'unparseable-stdout' });
            }
        });
        // Best-effort: hand the batch to the child. A dead child yields EPIPE — swallow.
        try {
            child.stdin?.write(JSON.stringify(input));
            child.stdin?.end();
        }
        catch { /* child already gone — close/error handler settles */ }
    });
}
// --- Child entry ------------------------------------------------------------
//
// Spawned as `node codegraph-query-runner.js`. Reads the batch from stdin, runs the
// SDK queries in-process (no watcher), and writes `{searches,callers}` JSON to stdout.
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
}
async function runChild() {
    process.env.CODEGRAPH_NO_WATCH = '1';
    const raw = await readStdin();
    const input = JSON.parse(raw);
    const mod = (await import('@colbymchenry/codegraph'));
    const bag = mod.default ?? mod;
    const CodeGraph = bag.CodeGraph;
    if (!CodeGraph)
        throw new Error('CodeGraph unavailable');
    const graph = (CodeGraph.open
        ? await CodeGraph.open(input.workingDir)
        : await CodeGraph.init?.(input.workingDir));
    if (!graph)
        throw new Error('graph open failed');
    const searches = {};
    for (const term of input.searches ?? []) {
        const r = graph.searchNodes(term);
        searches[term] = Array.isArray(r)
            ? r.map((x) => {
                const rec = (x ?? {});
                const node = 'node' in rec ? rec.node : x;
                const score = typeof rec.score === 'number' ? rec.score : 0;
                return { node, score };
            })
            : [];
    }
    const callers = {};
    for (const id of input.callers ?? []) {
        const c = graph.getCallers(id);
        callers[id] = Array.isArray(c) ? c : [];
    }
    try {
        graph.close?.();
    }
    catch { /* release best-effort */ }
    process.stdout.write(JSON.stringify({ searches, callers }));
    // Deterministic exit for the spawned worker child: the parent settles on the
    // child `close`, so a lingering SDK handle would else look like a false timeout.
    // This is a CLI child entry (guarded below), not library code.
    // eslint-disable-next-line pickle/no-process-exit-in-library
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'codegraph-query-runner.js') {
    runChild().catch((err) => {
        process.stderr.write(err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line pickle/no-process-exit-in-library
        process.exit(1);
    });
}
