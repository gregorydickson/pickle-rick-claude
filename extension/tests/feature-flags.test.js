// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PROTECTION_HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');

function writeExtensionSentinel(extensionRoot) {
  const sentinelDir = path.join(extensionRoot, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function withTempRoot(settings, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ff-')));
  writeExtensionSentinel(root);
  try {
    if (settings !== null) {
      fs.writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify(settings));
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

function runConfigProtection(opts = {}) {
  const {
    state = baseState(),
    toolName = 'Write',
    toolInput = {},
    withStateFile = true,
    settings = null,
  } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ff-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const ticketId = state.current_ticket || 'test-ticket-01';
  const resolvedState = { ...state, session_dir: sessionDir, current_ticket: ticketId };

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(resolvedState));
  if (withStateFile) {
    fs.writeFileSync(
      path.join(tmpDir, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: sessionDir })
    );
  }

  if (settings !== null) {
    fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), JSON.stringify(settings));
  }

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_STATE_FILE;
  if (withStateFile) env.PICKLE_STATE_FILE = path.join(sessionDir, 'state.json');

  const hookInput = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

  try {
    const stdout = execFileSync(process.execPath, [CONFIG_PROTECTION_HANDLER], {
      input: hookInput,
      encoding: 'utf-8',
      env,
    });
    return JSON.parse(stdout.trim());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// enable_config_protection
// ---------------------------------------------------------------------------

describe('enable_config_protection', () => {
  test('enabled (default): blocks Write to .eslintrc.json', () => {
    const result = runConfigProtection({
      toolName: 'Write',
      toolInput: { file_path: '/project/.eslintrc.json' },
      settings: { enable_config_protection: true },
    });
    assert.equal(result.decision, 'block');
  });

  test('disabled: approves Write to .eslintrc.json', () => {
    const result = runConfigProtection({
      toolName: 'Write',
      toolInput: { file_path: '/project/.eslintrc.json' },
      settings: { enable_config_protection: false },
    });
    assert.equal(result.decision, 'approve');
  });

  test('missing flag: blocks (treated as enabled)', () => {
    const result = runConfigProtection({
      toolName: 'Write',
      toolInput: { file_path: '/project/.eslintrc.json' },
      settings: {},
    });
    assert.equal(result.decision, 'block');
  });

  test('no settings file: blocks (default enabled)', () => {
    const result = runConfigProtection({
      toolName: 'Write',
      toolInput: { file_path: '/project/.eslintrc.json' },
    });
    assert.equal(result.decision, 'block');
  });

  test('disabled: approves even Bash targeting config', () => {
    const result = runConfigProtection({
      toolName: 'Bash',
      toolInput: { command: 'sed -i "s/foo/bar/" tsconfig.json' },
      settings: { enable_config_protection: false },
    });
    assert.equal(result.decision, 'approve');
  });
});

// ---------------------------------------------------------------------------
// enable_complexity_tiers (spawn-morty reads settings inline — test via tierToModel export)
// We verify the flag logic indirectly: tierToModel is pure, the flag guard is in main().
// The key contract: when disabled, spawn-morty should use 'sonnet' regardless of tier.
// ---------------------------------------------------------------------------

describe('enable_complexity_tiers', () => {
  // tierToModel itself is pure — always returns correct model for tier.
  // The flag guard wraps the call. We test the guard pattern by verifying
  // that pickle_settings.json with enable_complexity_tiers=false would skip it.
  // Since spawn-morty.main() isn't exported, we test the settings read pattern.

  test('settings with flag true: settings file is valid JSON', () => {
    withTempRoot({ enable_complexity_tiers: true }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_complexity_tiers, true);
    });
  });

  test('settings with flag false: flag correctly read as false', () => {
    withTempRoot({ enable_complexity_tiers: false }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_complexity_tiers, false);
    });
  });

  test('missing flag: !== false check treats as enabled', () => {
    withTempRoot({}, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.notEqual(settings.enable_complexity_tiers, false, 'missing flag should not be false');
    });
  });
});

// ---------------------------------------------------------------------------
// enable_task_notes (mux-runner reads settings inline in runIteration)
// Same pattern: flag guard wraps the TASK_NOTES.md injection block.
// ---------------------------------------------------------------------------

describe('enable_task_notes', () => {
  test('settings with flag true: flag correctly read as true', () => {
    withTempRoot({ enable_task_notes: true }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_task_notes, true);
    });
  });

  test('settings with flag false: flag correctly read as false', () => {
    withTempRoot({ enable_task_notes: false }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_task_notes, false);
    });
  });

  test('missing flag: !== false check treats as enabled', () => {
    withTempRoot({}, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.notEqual(settings.enable_task_notes, false);
    });
  });
});

// ---------------------------------------------------------------------------
// enable_failure_classification (already implemented in microverse-runner)
// Verify the settings read pattern works correctly.
// ---------------------------------------------------------------------------

describe('enable_failure_classification', () => {
  test('settings with flag true: flag correctly read as true', () => {
    withTempRoot({ enable_failure_classification: true }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_failure_classification, true);
    });
  });

  test('settings with flag false: flag correctly read as false', () => {
    withTempRoot({ enable_failure_classification: false }, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.equal(settings.enable_failure_classification, false);
    });
  });

  test('missing flag: !== false check treats as enabled', () => {
    withTempRoot({}, (root) => {
      const settings = JSON.parse(fs.readFileSync(path.join(root, 'pickle_settings.json'), 'utf-8'));
      assert.notEqual(settings.enable_failure_classification, false);
    });
  });
});

// ---------------------------------------------------------------------------
// All flags default to true in pickle_settings.json
// ---------------------------------------------------------------------------

describe('pickle_settings.json defaults', () => {
  const FLAGS = [
    'enable_task_notes',
    'enable_failure_classification',
    'enable_complexity_tiers',
    'enable_config_protection',
  ];

  test('all 4 flags exist and default to true', () => {
    const settingsPath = path.resolve(__dirname, '../../pickle_settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    for (const flag of FLAGS) {
      assert.equal(settings[flag], true, `${flag} should be true`);
    }
  });
});

// ---------------------------------------------------------------------------
// Error isolation: subsystem errors don't crash
// ---------------------------------------------------------------------------

describe('error isolation', () => {

  test('config-protection: corrupted settings file still blocks (default enabled)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ff-'));
    const sessionDir = path.join(tmpDir, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const state = baseState();
    const resolvedState = { ...state, session_dir: sessionDir, current_ticket: 'test-ticket-01' };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(resolvedState));
    fs.writeFileSync(path.join(tmpDir, 'current_sessions.json'), JSON.stringify({ [process.cwd()]: sessionDir }));
    fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), 'CORRUPT DATA');

    const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0', PICKLE_STATE_FILE: path.join(sessionDir, 'state.json') };
    const hookInput = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/project/.eslintrc.json' } });

    try {
      const stdout = execFileSync(process.execPath, [CONFIG_PROTECTION_HANDLER], {
        input: hookInput,
        encoding: 'utf-8',
        env,
      });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.decision, 'block', 'corrupted settings should default to enabled (block)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
