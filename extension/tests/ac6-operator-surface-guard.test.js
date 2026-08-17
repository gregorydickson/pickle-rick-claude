// @tier: trivial
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { test, describe } from 'node:test';

/**
 * AC-6: Operator/terminal surface guard test.
 *
 * Asserts that teardown fixes do not add new members to the operator and terminal surfaces:
 * - exit_reason values (EXIT_REASONS enum)
 * - terminal/abort call sites (functions returning :never)
 * - pickle_settings.json keys
 * - CLI parser flags (setup.ts)
 *
 * Parametrized: one row per surface, checking that post-fix set equals pre-fix set
 * at base sha 0d7e58dc.
 */

const BASE_SHA = '0d7e58dc';
const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.join(__dirname, '..');

// Baseline inventories from base sha (git show)
const BASE_INVENTORIES = {
  EXIT_REASONS: [
    'success', 'cancelled', 'error', 'limit', 'iteration_cap_exhausted', 'stall', 'circuit_open',
    'rate_limit_exhausted', 'timeout_repeat', 'manager_persistent_hallucination',
    'codex_unhealthy_consecutive_failures', 'working_tree_modified_externally',
    'state_schema_version_ahead', 'closer_handoff_terminal', 'manager_handoff_pending',
    'done_without_commit_evidence', 'codex_manager_no_progress', 'recovery_exhausted',
    'idle_stall_unrecoverable', 'state_working_dir_missing', 'toolchain_unavailable',
  ],
  TERMINAL_ABORT_SITES: [
    'bin/archaeology.ts:76',
    'bin/calibrate.ts:18',
    'bin/check-readiness.ts:148',
    'bin/correct-course.ts:63',
    'bin/debate.ts:122',
    'bin/init-microverse.ts:38',
    'bin/mux-runner.ts:135',
    'bin/setup.ts:255',
    'bin/spawn-morty.ts:364',
    'bin/spawn-refinement-team.ts:994',
    'bin/test-runner.ts:57',
    'bin/test-runner.ts:298',
    'services/council-schema.ts:93',
  ],
  PICKLE_SETTINGS_KEYS: [
    '_hardening_doc',
    '_iteration_budget_per_backend_doc',
    '_scope_doc',
    '_throughput_baselines_doc',
    '_worker_mcp_config_path_doc',
    '_worker_mcp_snapshot_servers_doc',
    'auto_update_enabled',
    'bmad_hardening',
    'codegraph',
    'commit_pending_probe_threshold',
    'convergence_gate',
    'default_cb_half_open_after',
    'default_cb_no_progress_threshold',
    'default_cb_same_error_threshold',
    'default_circuit_breaker_enabled',
    'default_codex_model',
    'default_council_max_rounds',
    'default_council_min_rounds',
    'default_council_publish',
    'default_manager_max_turns',
    'default_max_iterations',
    'default_max_rate_limit_retries',
    'default_rate_limit_wait_minutes',
    'default_refinement_cycles',
    'default_refinement_max_turns',
    'default_tmux_max_turns',
    'default_worker_timeout_seconds',
    'enable_backend_routing_heuristic',
    'enable_complexity_tiers',
    'enable_config_protection',
    'enable_failure_classification',
    'enable_task_notes',
    'hardening',
    'iteration_budget_per_backend',
    'manager_idle_backoff_fallback_ms',
    'microverse',
    'pipeline_continue_on_phase_fail',
    'rate_limit',
    'schema_version',
    'scope',
    'throughput_baselines',
    'throughput_baselines_units',
    'update_check_interval_hours',
    'worker_gate_tier',
    'worker_mcp_config_path',
    'worker_mcp_snapshot_servers',
  ],
  CLI_FLAGS: [
    '--acknowledge-undersized',
    '--backend',
    '--command-template',
    '--completion-promise',
    '--effort',
    '--force-ticket-status-sync',
    '--max-iterations',
    '--max-parallel',
    '--max-time',
    '--min-iterations',
    '--paused',
    '--repin',
    '--reset',
    '--resume',
    '--session-id',
    '--task',
    '--teams',
    '--tmux',
    '--worker-backend',
    '--worker-timeout',
  ],
};

/**
 * Extract exit_reason values from types/index.ts
 */
function extractExitReasons(content) {
  const match = content.match(/export const EXIT_REASONS = \[([\s\S]*?)\] as const;/);
  if (!match) return [];
  const entries = match[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  return entries;
}

/**
 * Extract terminal/abort call sites by searching for functions returning :never
 */
function extractTerminalAbortSites(extensionDir) {
  const sites = [];
  const srcDir = path.join(extensionDir, 'src');

  try {
    // Use git grep to find all ): never declarations
    const output = execSync(
      `git grep -n "): never" -- "${srcDir}"`,
      { encoding: 'utf8', cwd: path.dirname(extensionDir) }
    );

    output.split('\n').forEach(line => {
      if (!line.trim()) return;
      // Parse lines like: extension/src/bin/setup.ts:255:function die(message: string): never {
      // Format: extension/src/FILEPATH:LINENUM:CONTENT
      const match = line.match(/^extension\/src\/(.+):(\d+):(.*)$/);
      if (match) {
        const filePath = match[1];
        const lineNum = match[2];
        const lineContent = match[3];
        // Exclude comments (lines starting with //)
        if (!lineContent.trim().startsWith('//')) {
          sites.push(`${filePath}:${lineNum}`);
        }
      }
    });
  } catch {
    // git grep not available or no matches
  }

  return sites.sort();
}

/**
 * Extract pickle_settings.json keys
 */
function extractPickleSettingsKeys(content) {
  try {
    const obj = JSON.parse(content);
    return Object.keys(obj).sort();
  } catch {
    return [];
  }
}

/**
 * Extract CLI flags from setup.ts by looking for --flagname patterns
 */
function extractCliFlags(content) {
  const flags = [];
  // Match patterns like: '--flag-name': (config, args, index) => {
  const matches = content.matchAll(/'(--[a-z0-9-]+)':/g);
  for (const match of matches) {
    flags.push(match[1]);
  }
  return [...new Set(flags)].sort();
}

/**
 * Parametrized inventory check
 */
const INVENTORY_CHECKS = [
  {
    name: 'exit_reason values (EXIT_REASONS enum)',
    surface: 'EXIT_REASONS',
    getBaseline: () => BASE_INVENTORIES.EXIT_REASONS.sort(),
    getCurrent: () => {
      const typesPath = path.join(EXTENSION_DIR, 'src', 'types', 'index.ts');
      const content = fs.readFileSync(typesPath, 'utf8');
      return extractExitReasons(content).sort();
    },
  },
  {
    name: 'terminal/abort call sites (functions returning :never)',
    surface: 'TERMINAL_ABORT_SITES',
    getBaseline: () => BASE_INVENTORIES.TERMINAL_ABORT_SITES.sort(),
    getCurrent: () => extractTerminalAbortSites(EXTENSION_DIR).sort(),
  },
  {
    name: 'pickle_settings.json keys',
    surface: 'PICKLE_SETTINGS_KEYS',
    getBaseline: () => BASE_INVENTORIES.PICKLE_SETTINGS_KEYS.sort(),
    getCurrent: () => {
      const settingsPath = path.join(EXTENSION_DIR, '..', 'pickle_settings.json');
      const content = fs.readFileSync(settingsPath, 'utf8');
      return extractPickleSettingsKeys(content).sort();
    },
  },
  {
    name: 'CLI parser flags (setup.ts)',
    surface: 'CLI_FLAGS',
    getBaseline: () => BASE_INVENTORIES.CLI_FLAGS.sort(),
    getCurrent: () => {
      const setupPath = path.join(EXTENSION_DIR, 'src', 'bin', 'setup.ts');
      const content = fs.readFileSync(setupPath, 'utf8');
      return extractCliFlags(content).sort();
    },
  },
];

describe('AC-6: Operator/terminal surface guard', () => {
  INVENTORY_CHECKS.forEach(check => {
    test(`${check.name}`, () => {
      const baseline = check.getBaseline();
      const current = check.getCurrent();

      // Check for new members (current - baseline)
      const added = current.filter(item => !baseline.includes(item));
      if (added.length > 0) {
        assert.fail(
          `${check.surface}: added ${added.length} new member(s) not in base sha ${BASE_SHA}: ${added.join(', ')}`
        );
      }

      // Check for removed members (baseline - current) to catch mutation test
      const removed = baseline.filter(item => !current.includes(item));
      if (removed.length > 0) {
        assert.fail(
          `${check.surface}: removed ${removed.length} member(s) from base sha ${BASE_SHA}: ${removed.join(', ')}`
        );
      }

      // Ensure counts match
      assert.strictEqual(
        current.length,
        baseline.length,
        `${check.surface}: member count mismatch (expected ${baseline.length}, got ${current.length})`
      );
    });
  });
});
