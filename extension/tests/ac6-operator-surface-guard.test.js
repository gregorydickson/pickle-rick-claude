// @tier: fast
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { test, describe } from 'node:test';
import * as ts from 'typescript';

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
    'bin/archaeology.ts::usage',
    'bin/calibrate.ts::usage',
    'bin/check-readiness.ts::usage',
    'bin/correct-course.ts::usage',
    'bin/debate.ts::usage',
    'bin/init-microverse.ts::fail',
    'bin/mux-runner.ts::handleSchemaVersionAhead',
    'bin/setup.ts::die',
    'bin/spawn-morty.ts::die',
    'bin/spawn-refinement-team.ts::usageAndExit',
    'bin/test-runner.ts::exitWithError',
    'bin/test-runner.ts::main',
    'services/council-schema.ts::fail',
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
 * Enumerate .ts files under <extensionDir>/src the way git owns them: tracked files
 * (git ls-files) plus untracked-but-not-ignored files (git ls-files --others --exclude-standard).
 * Gitignored files never appear in either list, so they are excluded without a separate check.
 */
function enumerateGitOwnedTsFiles(extensionDir) {
  const repoRoot = path.dirname(extensionDir);
  const srcDir = path.join(extensionDir, 'src');
  const srcRelToRepo = path.relative(repoRoot, srcDir);

  const tracked = execSync(`git ls-files -- "${srcRelToRepo}"`, {
    encoding: 'utf8', cwd: repoRoot, timeout: 30000,
  });
  const untracked = execSync(`git ls-files --others --exclude-standard -- "${srcRelToRepo}"`, {
    encoding: 'utf8', cwd: repoRoot, timeout: 30000,
  });

  const relPaths = [...tracked.split('\n'), ...untracked.split('\n')]
    .map(l => l.trim())
    .filter(Boolean)
    .filter(p => p.endsWith('.ts'));

  return [...new Set(relPaths)].map(p => path.join(repoRoot, p)).sort();
}

/**
 * Resolve the symbol name for a function-like node whose return type is `never`.
 * Returns null when the node has no recoverable name (caller must fail loud on null).
 */
function resolveAbortSiteSymbolName(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isMethodDeclaration(node)) {
    return (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : null;
  }
  if (ts.isFunctionExpression(node) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  // ArrowFunction, or an unnamed FunctionExpression: resolve identity via the parent.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)
      && (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name))) {
    return parent.name.text;
  }
  return null;
}

/**
 * Walk one file's content and return `<relFile>::<symbolName>` identities for every function-like
 * node (FunctionDeclaration, MethodDeclaration, ArrowFunction, FunctionExpression) whose return
 * type is the bare `never` keyword. The function-like check MUST precede the `.type` check: a
 * bare `.type.kind === NeverKeyword` test also matches `as never` AsExpression casts, which are
 * not function-like and must never appear in the abort-site surface.
 */
function extractAbortSitesFromSource(content, relFile) {
  const sourceFile = ts.createSourceFile(relFile, content, ts.ScriptTarget.Latest, true);
  const sites = [];

  function visit(node) {
    const isFunctionLike = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
    if (isFunctionLike && node.type && node.type.kind === ts.SyntaxKind.NeverKeyword) {
      const symbolName = resolveAbortSiteSymbolName(node);
      if (!symbolName) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(`unrecoverable symbol at ${relFile}:${line + 1}`);
      }
      sites.push(`${relFile}::${symbolName}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

/**
 * Read one .ts file from disk and delegate to `extractAbortSitesFromSource`.
 */
function extractAbortSitesFromFile(absPath, srcDir) {
  const content = fs.readFileSync(absPath, 'utf8');
  const relFile = path.relative(srcDir, absPath).split(path.sep).join('/');
  return extractAbortSitesFromSource(content, relFile);
}

/**
 * Extract terminal/abort call sites by identity: git owns which .ts files exist
 * (ignore-aware enumeration), the TypeScript AST owns which symbols are abort sites
 * (`<file>::<symbolName>`). No dedupe, no drop: every occurrence is kept, and a collision
 * (two sites resolving to the same identity) or an unrecoverable symbol fails loud.
 */
function extractTerminalAbortSites(extensionDir) {
  const srcDir = path.join(extensionDir, 'src');
  const files = enumerateGitOwnedTsFiles(extensionDir);
  const allSites = files.flatMap(f => extractAbortSitesFromFile(f, srcDir));

  const counts = new Map();
  for (const site of allSites) {
    counts.set(site, (counts.get(site) || 0) + 1);
  }
  for (const [site, count] of counts) {
    if (count > 1) {
      throw new Error(`collision: ${site} appears ${count} times`);
    }
  }

  return allSites.sort();
}

/**
 * Diff a baseline inventory against a current one by set membership. Used by both the production
 * parametrized guard and the fixture tests exercising the guard's added/removed semantics
 * directly, so the fixture tests prove the actual guard behavior rather than a reimplementation.
 */
function diffAbortSiteInventory(baseline, current) {
  return {
    added: current.filter(item => !baseline.includes(item)),
    removed: baseline.filter(item => !current.includes(item)),
  };
}

/**
 * Return items that appear more than once in `items`. Membership-based diffing (added/removed)
 * is blind to multiplicity, so this is the only check that can catch an accidentally-duplicated
 * inventory literal — and unlike a bare length comparison, it always names the offending item(s).
 */
function findDuplicateMembers(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([item]) => item);
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
      const { added, removed } = diffAbortSiteInventory(baseline, current);
      if (added.length > 0) {
        assert.fail(
          `${check.surface}: added ${added.length} new member(s) not in base sha ${BASE_SHA}: ${added.join(', ')}`
        );
      }

      // Check for removed members (baseline - current) to catch mutation test
      if (removed.length > 0) {
        assert.fail(
          `${check.surface}: removed ${removed.length} member(s) from base sha ${BASE_SHA}: ${removed.join(', ')}`
        );
      }

      // added/removed above are set-membership checks and are blind to multiplicity: a
      // duplicated literal in either array would satisfy both while still being a defect. Name
      // the offending symbol(s) explicitly rather than falling through to a bare count mismatch.
      const duplicateCurrent = findDuplicateMembers(current);
      if (duplicateCurrent.length > 0) {
        assert.fail(
          `${check.surface}: duplicate member(s) in current extraction: ${duplicateCurrent.join(', ')}`
        );
      }
      const duplicateBaseline = findDuplicateMembers(baseline);
      if (duplicateBaseline.length > 0) {
        assert.fail(
          `${check.surface}: duplicate member(s) in baseline: ${duplicateBaseline.join(', ')}`
        );
      }
    });
  });
});

/**
 * Build a throwaway git repo shaped like `<tmp>/extension/src/...` so
 * `enumerateGitOwnedTsFiles(path.join(tmp, 'extension'))` matches production's directory shape.
 */
function makeFixtureRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac6-abort-site-fixture-'));
  const extensionDir = path.join(tmp, 'extension');
  const srcDir = path.join(extensionDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  execSync('git init', { cwd: tmp, stdio: 'pipe', timeout: 30000 });
  execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: 'pipe', timeout: 30000 });
  execSync('git config user.name "Test"', { cwd: tmp, stdio: 'pipe', timeout: 30000 });
  return { tmp, extensionDir, srcDir };
}

describe('AST abort-site extractor: enumeration and identity', () => {
  test('ignore-aware enumeration: untracked included, gitignored excluded', () => {
    const { tmp, extensionDir, srcDir } = makeFixtureRepo();
    try {
      fs.writeFileSync(
        path.join(srcDir, 'tracked.ts'),
        'function trackedAbort(): never { throw new Error("x"); }\n'
      );
      fs.writeFileSync(
        path.join(srcDir, 'untracked.ts'),
        'function untrackedAbort(): never { throw new Error("x"); }\n'
      );
      fs.writeFileSync(path.join(tmp, '.gitignore'), 'extension/src/generated.ts\n');
      fs.writeFileSync(
        path.join(srcDir, 'generated.ts'),
        'function generatedAbort(): never { throw new Error("x"); }\n'
      );
      execSync('git add extension/src/tracked.ts .gitignore', { cwd: tmp, stdio: 'pipe', timeout: 30000 });
      execSync('git commit -m "init"', { cwd: tmp, stdio: 'pipe', timeout: 30000 });

      const files = enumerateGitOwnedTsFiles(extensionDir).map(f => path.basename(f));

      assert.ok(files.includes('tracked.ts'), 'tracked file must be enumerated');
      assert.ok(files.includes('untracked.ts'), 'untracked-but-not-ignored file must be enumerated');
      assert.ok(!files.includes('generated.ts'), 'gitignored file must be excluded');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('collision fails loud: two same-named never-returning functions in one file', () => {
    const { tmp, extensionDir, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'dupe.ts');
      fs.writeFileSync(
        filePath,
        'function abort(): never { throw new Error("x"); }\n'
        + 'function abort(): never { throw new Error("y"); }\n'
      );

      assert.throws(
        () => extractTerminalAbortSites(extensionDir),
        /collision: dupe\.ts::abort appears 2 times/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unrecoverable symbol fails loud: unparented never-returning function expression', () => {
    const { tmp, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'anon.ts');
      fs.writeFileSync(
        filePath,
        '[(function(): never { throw new Error("x"); })].forEach(f => f());\n'
      );

      assert.throws(
        () => extractAbortSitesFromFile(filePath, srcDir),
        /unrecoverable symbol at anon\.ts:\d+/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('function-like gate precedes the .type check: as-never casts are excluded', () => {
    const { tmp, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'cast.ts');
      fs.writeFileSync(
        filePath,
        'function realAbort(): never { throw new Error("x"); }\n'
        + 'const x = { event: "boom" as never };\n'
        + 'function useCast() { doThing({ payload: 1 } as never); }\n'
      );

      const sites = extractAbortSitesFromFile(filePath, srcDir);

      assert.deepStrictEqual(sites, ['cast.ts::realAbort']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('7 known as-never casts at HEAD produce zero abort-site entries', () => {
    const castFiles = [
      'bin/microverse-runner.ts',
      'bin/pipeline-runner.ts',
      'hooks/handlers/tsc-gate.ts',
    ];
    const sites = extractTerminalAbortSites(EXTENSION_DIR);
    for (const relFile of castFiles) {
      assert.ok(
        !sites.some(site => site.startsWith(`${relFile}::`)),
        `${relFile} must contribute no abort-site entries (its only ": never" surface is an "as never" cast)`
      );
    }
  });

  test('AC-3: moving a tracked function within its file does not fire the guard (line shift)', () => {
    const { tmp, extensionDir, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'shifted.ts');
      fs.writeFileSync(filePath, 'function shiftedAbort(): never { throw new Error("x"); }\n');
      const baseline = extractTerminalAbortSites(extensionDir);

      fs.writeFileSync(
        filePath,
        '\n\n// pushed down by unrelated edits\n'
        + 'function shiftedAbort(): never { throw new Error("x"); }\n'
      );
      const current = extractTerminalAbortSites(extensionDir);

      const { added, removed } = diffAbortSiteInventory(baseline, current);
      assert.deepStrictEqual(added, []);
      assert.deepStrictEqual(removed, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC-4: adding a real function-like : never declaration fires the guard', () => {
    const { tmp, extensionDir, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'addition.ts');
      fs.writeFileSync(filePath, 'function existingAbort(): never { throw new Error("x"); }\n');
      const baseline = extractTerminalAbortSites(extensionDir);

      fs.writeFileSync(
        filePath,
        'function existingAbort(): never { throw new Error("x"); }\n'
        + 'function newAbort(): never { throw new Error("y"); }\n'
      );
      const current = extractTerminalAbortSites(extensionDir);

      const { added, removed } = diffAbortSiteInventory(baseline, current);
      assert.deepStrictEqual(removed, []);
      assert.deepStrictEqual(added, ['addition.ts::newAbort']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC-4: removing a tracked site fires the removal arm', () => {
    const { tmp, extensionDir, srcDir } = makeFixtureRepo();
    try {
      const filePath = path.join(srcDir, 'removal.ts');
      fs.writeFileSync(
        filePath,
        'function keptAbort(): never { throw new Error("x"); }\n'
        + 'function droppedAbort(): never { throw new Error("y"); }\n'
      );
      const baseline = extractTerminalAbortSites(extensionDir);

      fs.writeFileSync(filePath, 'function keptAbort(): never { throw new Error("x"); }\n');
      const current = extractTerminalAbortSites(extensionDir);

      const { added, removed } = diffAbortSiteInventory(baseline, current);
      assert.deepStrictEqual(added, []);
      assert.deepStrictEqual(removed, ['removal.ts::droppedAbort']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Materialize `extension/src` as it existed at `sha` into a throwaway git repo shaped like
 * `makeFixtureRepo()`'s output, so `extractTerminalAbortSites` can be reused unmodified against
 * genuine historical content instead of a hardcoded literal. `makeFixtureRepo()` names its
 * extension dir `extension` to mirror production's own `<repoRoot>/extension` layout, so the
 * archive's internal path prefix (`extension/src/...`, relative to the real repo root) lands
 * directly at `tmp/extension/src/...` — the exact path `extensionDir/src` already resolves to.
 * No rename is needed; tar populates the empty `src/` dir `makeFixtureRepo()` created in place.
 */
function materializeShaFixtureRepo(sha) {
  const repoRoot = path.dirname(EXTENSION_DIR);
  const srcRelToRepo = path.relative(repoRoot, path.join(EXTENSION_DIR, 'src'));
  const { tmp, extensionDir } = makeFixtureRepo();

  execSync(`git archive ${sha} -- "${srcRelToRepo}" | tar -x -C "${tmp}"`, {
    cwd: repoRoot, stdio: 'pipe', timeout: 30000,
  });

  return { tmp, extensionDir };
}

describe('AC-5: two-sha baseline equality proof', () => {
  test('extractor output at HEAD and at BASE_SHA is byte-identical (set equality)', () => {
    const atHead = extractTerminalAbortSites(EXTENSION_DIR).sort();

    const { tmp, extensionDir } = materializeShaFixtureRepo(BASE_SHA);
    let atBase;
    try {
      atBase = extractTerminalAbortSites(extensionDir).sort();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.deepStrictEqual(
      atHead,
      atBase,
      `TERMINAL_ABORT_SITES must be byte-identical between HEAD and base sha ${BASE_SHA}`
    );
  });
});
