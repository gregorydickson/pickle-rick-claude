// @tier: integration
/**
 * R-MMTR-6B: Replay-stubbed E2E harness for max-turns manager relaunch.
 *
 * Drives processIterationOutcome from bin/mux-runner.js with synthetic
 * outcomes and fixture-based session state — no real CLI spawn.
 *
 * Consumed by R-MMTR-6C test assertions. This file is orchestration only;
 * it contains no test(...) calls.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import from compiled mux-runner output (not TypeScript source)
import {
  processIterationOutcome,
} from '../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.join(__dirname, '../fixtures/mmtr6-synthetic-session');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  sessionFixture?: string;
  expectedRelaunchCount: number;
  expectedDoneCount: number;
}

export interface HarnessResult {
  relaunchCount: number;
  doneCount: number;
  activityEvents: unknown[];
  finalTicketStatuses: Record<string, string>;
  teardownReason: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function copyRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function parseTicketStatus(content: string): string {
  const match = content.match(/^status:\s*["']?([^\n"']+?)["']?\s*$/m);
  return match ? match[1].trim() : 'Unknown';
}

function readFinalTicketStatuses(sessionDir: string): Record<string, string> {
  const statuses: Record<string, string> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return statuses;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticketFile = path.join(sessionDir, entry.name, `rick_ticket_${entry.name}.md`);
    try {
      const content = fs.readFileSync(ticketFile, 'utf-8');
      statuses[entry.name] = parseTicketStatus(content);
    } catch {
      // skip missing or unreadable ticket files
    }
  }
  return statuses;
}

function advanceOneTicketToDone(sessionDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort deterministically by directory name so we advance in order
  const sorted = entries
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const ticketFile = path.join(sessionDir, entry.name, `rick_ticket_${entry.name}.md`);
    let content: string;
    try {
      content = fs.readFileSync(ticketFile, 'utf-8');
    } catch {
      continue;
    }
    const status = parseTicketStatus(content);
    const statusLower = status.toLowerCase().replace(/["']/g, '').trim();
    if (statusLower === 'done' || statusLower === 'skipped') continue;

    // Rewrite status to Done in the frontmatter
    const updated = content.replace(
      /^(status:\s*)["']?[^\n"']+["']?\s*$/m,
      '$1Done',
    );
    fs.writeFileSync(ticketFile, updated);
    return;
  }
}

// ---------------------------------------------------------------------------
// Max-turns iter-log content
// ---------------------------------------------------------------------------

function buildMaxTurnsIterLog(maxTurns: number): string {
  return JSON.stringify({
    type: 'result',
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    is_error: false,
    num_turns: maxTurns,
  }) + '\n';
}

// ---------------------------------------------------------------------------
// Main harness export
// ---------------------------------------------------------------------------

export async function runMaxTurnsRelaunchE2E({
  sessionFixture = DEFAULT_FIXTURE,
  expectedRelaunchCount,
  expectedDoneCount,
}: HarnessOptions): Promise<HarnessResult> {
  const tmpDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mmtr6-e2e-')),
  );

  try {
    // -----------------------------------------------------------------------
    // (a) Copy fixture → tmpdir; rewrite working_dir / session_dir / start_time_epoch
    // -----------------------------------------------------------------------
    copyRecursive(sessionFixture, tmpDir);

    // The R-MMTR-6A fixture uses session_state.json as the root state file
    const stateFixturePath = path.join(tmpDir, 'session_state.json');
    const statePath = path.join(tmpDir, 'state.json');
    if (fs.existsSync(stateFixturePath)) {
      fs.copyFileSync(stateFixturePath, statePath);
    }

    const stateRaw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    stateRaw['working_dir'] = tmpDir;
    stateRaw['session_dir'] = tmpDir;
    stateRaw['start_time_epoch'] = Math.floor(Date.now() / 1000);
    fs.writeFileSync(statePath, JSON.stringify(stateRaw, null, 2));

    // -----------------------------------------------------------------------
    // Collect telemetry
    // -----------------------------------------------------------------------
    const logs: string[] = [];
    const deactivateCalls: string[] = [];
    let relaunchCount = 0;
    let teardownReason: string | null = null;

    // Start from the fixture's iteration counter
    let iteration = typeof stateRaw['iteration'] === 'number' ? stateRaw['iteration'] : 3;
    const maxTurns = 40;

    // -----------------------------------------------------------------------
    // (b) Drive processIterationOutcome for up to expectedRelaunchCount+1 passes
    // -----------------------------------------------------------------------
    const maxPasses = expectedRelaunchCount + 2;
    for (let pass = 0; pass < maxPasses; pass++) {
      // Write tmux_iteration_<N>.log with max-turns exit JSON
      const iterLogFile = path.join(tmpDir, `tmux_iteration_${iteration}.log`);
      fs.writeFileSync(iterLogFile, buildMaxTurnsIterLog(maxTurns));

      // Read current persisted state
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      // Synthetic outcome: clean max-turns exit
      const outcome = {
        completion: 'error' as const,
        timedOut: false as const,
        exitCode: 0,
        wallSeconds: 12,
      };

      // Build LoopContext — stub log + deactivate; leave readState unset (real file I/O)
      const ctx = {
        sessionDir: tmpDir,
        statePath,
        extensionRoot: process.cwd(),
        iteration,
        outcome,
        iterLogFile,
        maxTurns,
        cbState: null,
        log: (msg: string) => { logs.push(msg); },
        deactivate: (target: string) => { deactivateCalls.push(target); },
      };

      const action = await processIterationOutcome(state, outcome, ctx);

      if (action.kind === 'relaunch') {
        relaunchCount++;
        // (c) Advance one ticket to Done between passes to model progress
        // and satisfy the checkAndUpdateCodexManagerNoProgress decrease check
        advanceOneTicketToDone(tmpDir);
        iteration++;

        if (relaunchCount >= expectedRelaunchCount) {
          // Reached target relaunch count — stop
          break;
        }
      } else if (action.kind === 'break') {
        teardownReason = (action as { reason?: string }).reason ?? null;
        break;
      } else {
        // 'noop' or 'continue' — unexpected in max-turns scenario; stop gracefully
        break;
      }
    }

    // -----------------------------------------------------------------------
    // (d) Collect persisted state.json data
    // -----------------------------------------------------------------------
    let finalState: Record<string, unknown> = {};
    try {
      finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // leave as empty object on read failure
    }

    const activityEvents: unknown[] = Array.isArray(finalState['activity'])
      ? finalState['activity'] as unknown[]
      : [];

    // -----------------------------------------------------------------------
    // (e) Build and return HarnessResult
    // -----------------------------------------------------------------------
    const finalTicketStatuses = readFinalTicketStatuses(tmpDir);
    const doneCount = Object.values(finalTicketStatuses)
      .filter(s => s.toLowerCase().replace(/["']/g, '').trim() === 'done')
      .length;

    return {
      relaunchCount,
      doneCount,
      activityEvents,
      finalTicketStatuses,
      teardownReason,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
