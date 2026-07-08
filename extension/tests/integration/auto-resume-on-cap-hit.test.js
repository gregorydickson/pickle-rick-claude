// @tier: integration
/**
 * auto-resume-on-cap-hit.test.js — R-CNAR-5: Auto-resume integration tests.
 *
 * AR-CAP-1: Synthetic 5-ticket session — each ticket hits the iteration cap once.
 *   Auto-resume completes all 5 tickets within PICKLE_AUTO_RESUME_MAX_RETRIES.
 *
 * AR-KILL-1: SIGTERM to parent shell (R21 mitigation) — kill auto-resume.sh mid-retry;
 *   both the wrapper and child mux-runner must die within 5s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_RESUME_SH = path.resolve(__dirname, '../../scripts/auto-resume.sh');

const TICKET_IDS = ['ticket01', 'ticket02', 'ticket03', 'ticket04', 'ticket05'];

function makeTmpDir(prefix = 'ar-int-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeTicketMd(id, status = 'Todo') {
  return `---\nid: ${id}\ntitle: "Test ticket ${id}"\nstatus: ${status}\n---\n# Description\nTest.\n`;
}

function makeStateJson(sessionDir, currentTicket) {
  return JSON.stringify({
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'auto-resume cap-hit test',
    current_ticket: currentTicket,
    exit_reason: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 1,
  });
}

/** Scaffold session dir + extRoot with 5 Todo tickets. */
function makeCapHitFixture() {
  const tmp = makeTmpDir('ar-cap-');
  const extRoot = path.join(tmp, 'ext');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  for (const id of TICKET_IDS) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, `rick_ticket_${id}.md`),
      makeTicketMd(id, 'Todo'),
    );
  }

  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    makeStateJson(sessionDir, TICKET_IDS[0]),
  );

  return { tmp, extRoot, sessionDir };
}

/**
 * Fake mux-runner (CJS) that simulates a per-ticket iteration-cap-hit:
 *   - Marks state.current_ticket Done in its ticket file
 *   - Advances current_ticket to the next undone ticket
 *   - Sets exit_reason='pipeline_phase_incomplete' if more tickets remain
 *   - Sets exit_reason='completed' when all tickets are Done
 */
function makeCapHitRunner(ticketIds) {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const sessionDir = process.argv[2];
const stateFile = path.join(sessionDir, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const ticketIds = ${JSON.stringify(ticketIds)};
const currentId = state.current_ticket;
if (currentId) {
  const tf = path.join(sessionDir, currentId, 'rick_ticket_' + currentId + '.md');
  if (fs.existsSync(tf)) {
    const content = fs.readFileSync(tf, 'utf8');
    fs.writeFileSync(tf, content.replace(/^status: .*/m, 'status: Done'));
  }
}
const nextUndone = ticketIds.find(id => {
  const tf = path.join(sessionDir, id, 'rick_ticket_' + id + '.md');
  if (!fs.existsSync(tf)) return false;
  return !fs.readFileSync(tf, 'utf8').includes('status: Done');
});
if (nextUndone) {
  state.current_ticket = nextUndone;
  state.exit_reason = 'pipeline_phase_incomplete';
} else {
  state.exit_reason = 'completed';
  state.current_ticket = null;
}
fs.writeFileSync(stateFile, JSON.stringify(state));
`;
}

// ---------------------------------------------------------------------------
// AR-CAP-1: 5-ticket cap-hit — all tickets Done within MAX_RETRIES
// ---------------------------------------------------------------------------

test('AR-CAP-1: 5-ticket cap-hit session — all tickets Done within MAX_RETRIES', { timeout: 60_000 }, () => {
  const { tmp, extRoot, sessionDir } = makeCapHitFixture();
  try {
    fs.writeFileSync(
      path.join(extRoot, 'extension', 'bin', 'mux-runner.js'),
      makeCapHitRunner(TICKET_IDS),
    );

    const result = spawnSync('bash', [AUTO_RESUME_SH, sessionDir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PICKLE_AUTO_RESUME_ON_CAP_HIT: '1',
        PICKLE_INSTALL_ROOT: extRoot,
        PICKLE_AUTO_RESUME_MAX_RETRIES: '10',
      },
      timeout: 55_000,
    });

    // All 5 tickets must reach Done status
    for (const id of TICKET_IDS) {
      const ticketFile = path.join(sessionDir, id, `rick_ticket_${id}.md`);
      const content = fs.readFileSync(ticketFile, 'utf8');
      assert.ok(
        /^status: Done\s*$/m.test(content),
        `Ticket ${id} must be Done after auto-resume completes`,
      );
    }

    // Script must exit (not time out)
    assert.ok(result.status !== null, 'auto-resume.sh must exit normally, not hang');

    // Must have stopped because exit_reason was not pipeline_phase_incomplete
    assert.ok(
      result.stderr.includes("exit_reason='completed'"),
      `Expected stop on exit_reason=completed, got:\n${result.stderr}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AR-KILL-1: SIGTERM to parent shell kills wrapper + child mux-runner within 5s
// ---------------------------------------------------------------------------

test('AR-KILL-1: SIGTERM to parent shell — auto-resume.sh and child mux-runner both die within 5s', { timeout: 30_000 }, async () => {
  const tmp = makeTmpDir('ar-kill-');
  try {
    const extRoot = path.join(tmp, 'ext');
    const sessionDir = path.join(tmp, 'session');
    const pidFile = path.join(tmp, 'child-mux.pid');

    fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    // Fake mux-runner: writes its PID then hangs until killed
    const hangingRunner = `'use strict';
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
// Hang indefinitely — killed by parent shell's SIGTERM trap
setTimeout(() => {}, 3_600_000);
`;
    fs.writeFileSync(
      path.join(extRoot, 'extension', 'bin', 'mux-runner.js'),
      hangingRunner,
    );

    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ active: true, current_ticket: null, exit_reason: null }),
    );

    // Spawn auto-resume.sh as a foreground process we can signal
    const autoResume = spawn('bash', [AUTO_RESUME_SH, sessionDir], {
      env: {
        ...process.env,
        PICKLE_AUTO_RESUME_ON_CAP_HIT: '1',
        PICKLE_INSTALL_ROOT: extRoot,
        PICKLE_AUTO_RESUME_MAX_RETRIES: '10',
      },
      stdio: 'pipe',
    });

    // Wait for child mux-runner to start and write its PID (up to 10s)
    const pidDeadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < pidDeadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(
      fs.existsSync(pidFile),
      'child mux-runner must start and write PID file within 10s',
    );
    const childMuxPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    assert.ok(Number.isInteger(childMuxPid) && childMuxPid > 0, 'PID must be a valid positive integer');

    // Send SIGTERM to the parent shell (auto-resume.sh bash process)
    const killStart = Date.now();
    autoResume.kill('SIGTERM');

    // auto-resume.sh must exit within 5s of receiving SIGTERM
    await new Promise((resolve, reject) => {
      autoResume.on('exit', resolve);
      autoResume.on('error', reject);
      setTimeout(
        () => reject(new Error('auto-resume.sh did not exit within 5s after SIGTERM')),
        5_000,
      );
    });

    const elapsed = Date.now() - killStart;
    assert.ok(elapsed < 5_000, `auto-resume.sh must exit within 5s, took ${elapsed}ms`);

    // Give the child mux-runner a moment to die (SIGTERM propagation via bash trap)
    await new Promise(r => setTimeout(r, 500));

    function isPidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    assert.ok(
      !isPidAlive(childMuxPid),
      `child mux-runner PID ${childMuxPid} must be dead after parent shell receives SIGTERM (R21 mitigation)`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
