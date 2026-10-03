#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { sleep, detectLogTruncation } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';

const POLL_INTERVAL_MS = 2000;
const sm = new StateManager();

function resolveDisplay(raw: Record<string, unknown>, producerDone: boolean): string {
  const subsystem = typeof raw.current_subsystem === 'string' && raw.current_subsystem
    ? raw.current_subsystem : null;
  return subsystem ?? (producerDone ? 'Producer complete' : 'idle');
}

/** B-LANES WS-3: a lane's own one-lane roster names it; a lane that has not written one is `lane-<n>`. */
function readLaneName(laneDir: string, index: number): string {
  const roster = (readRecoverableJsonObject(path.join(laneDir, 'anatomy-park.json')) as Record<string, unknown> | null)?.lanes;
  const name = Array.isArray(roster) ? (roster[0] as { name?: unknown } | undefined)?.name : undefined;
  return typeof name === 'string' && name ? name : `lane-${index}`;
}

function readLaneStatus(laneDir: string): { passes: number; status: string } {
  try {
    const state = sm.read(path.join(laneDir, 'state.json'));
    const status = state.active === true ? 'running' : (state.exit_reason || 'ended');
    return { passes: typeof state.iteration === 'number' ? state.iteration : 0, status };
  } catch {
    return { passes: 0, status: 'starting' };
  }
}

/**
 * One line per lane session — the sibling dirs `<session>--lane-<n>` that concurrent
 * anatomy-park lanes run in — in lane order. Discovered by name, not from `archive/lanes.json`,
 * which is only written once every lane has ended.
 */
async function readLaneLines(sessionDir: string): Promise<string[]> {
  const resolved = path.resolve(sessionDir);
  const prefix = `${path.basename(resolved)}--lane-`;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(path.dirname(resolved));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && /^\d+$/.test(entry.slice(prefix.length)))
    .map((entry) => ({ entry, index: Number(entry.slice(prefix.length)) }))
    .sort((a, b) => a.index - b.index)
    .map(({ entry, index }) => {
      const laneDir = path.join(path.dirname(resolved), entry);
      const { passes, status } = readLaneStatus(laneDir);
      return `▸ ${readLaneName(laneDir, index)} · pass ${passes} · ${status}`;
    });
}

/** Two or more lanes: the parent's single current_subsystem no longer describes the run. */
async function resolveRender(
  sessionDir: string,
  data: Record<string, unknown> | null,
  producerDone: boolean,
): Promise<string | null> {
  const laneLines = await readLaneLines(sessionDir);
  if (laneLines.length >= 2) return laneLines.join('\n');
  // R-MDS-6: when subsystem is absent, check producer_done for message
  return data === null ? null : `▸ ${resolveDisplay(data, producerDone)}`;
}

async function main() {
  const sessionDir = process.argv[2];
  // eslint-disable-next-line pickle/no-sync-in-async -- intentional blocking call
  if (!sessionDir || sessionDir.startsWith('--') || !fs.existsSync(sessionDir)) {
    console.error('Usage: node subsystem-watcher.js <session-dir>');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    process.stdout.write('\nDetached.\n');
    process.exit(0);
  });

  const microversePath = path.join(sessionDir, 'microverse.json');
  const statePath = path.join(sessionDir, 'state.json');
  let lastRendered: string | undefined;
  let fileSize = 0;

  while (true) {
    // R-MWR-4: truncation resilience — detect if microverse.json shrank
    const trunc = detectLogTruncation(microversePath, fileSize, '');
    if (trunc.truncated) {
      fileSize = trunc.offset;
    }

    // Read state once per poll for both liveness and producer_done (R-MDS-6).
    let sessionActive = true;
    let producerDone = false;
    try {
      const stateSnap = sm.read(statePath);
      sessionActive = stateSnap.active === true;
      producerDone = stateSnap.monitor_panes?.[2]?.producer_done === true;
    } catch {
      /* session dir unreadable — keep polling */
    }

    const data = readRecoverableJsonObject(microversePath) as Record<string, unknown> | null;

    const display = await resolveRender(sessionDir, data, producerDone);

    if (display !== null && display !== lastRendered) {
      lastRendered = display;
      process.stdout.write(`${display}\n`);
    }

    if (data !== null) {
      try {
        fileSize = (await fs.promises.stat(microversePath)).size;
      } catch {
        fileSize = 0;
      }
    }

    // Liveness probe — exit after rendering current data
    if (!sessionActive) break;

    await sleep(POLL_INTERVAL_MS);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'subsystem-watcher.js') {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[subsystem-watcher] ${msg}`);
    process.exit(1);
  });
}
