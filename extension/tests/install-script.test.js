// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveWorkerTestGateTimeoutMs } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

/**
 * Extract the real `compare_semver` function body verbatim from install.sh
 * (no hand-copied fixture) by scanning brace depth from the `compare_semver() {`
 * marker to its matching closing brace. `${...}` parameter expansions inside the
 * body are individually balanced, so a flat brace-depth counter finds the right
 * boundary.
 */
function extractCompareSemverSource() {
  const src = readFileSync(INSTALL_SH, 'utf8');
  const marker = 'compare_semver() {';
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error('compare_semver() not found in install.sh');
  }
  let depth = 0;
  let pos = start;
  for (; pos < src.length; pos++) {
    const ch = src[pos];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        pos++;
        break;
      }
    }
  }
  return src.slice(start, pos);
}

/**
 * Build a minimal install.sh fixture that runs only the F3 schemaVersion
 * parity check from the real install.sh. SCRIPT_DIR is wired to the supplied
 * tmp dir so we can pin source/compiled schemaVersion values per case.
 */
function buildFixtureScript(scriptDir) {
  return `#!/bin/bash
set -e
SCRIPT_DIR="${scriptDir}"
SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
if [ -z "$SOURCE_VERSION" ] || [ -z "$COMPILED_VERSION" ]; then
  echo "❌ Could not extract schemaVersion from source or compiled types/index. Refusing to deploy." >&2
  exit 1
fi
if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
  echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) does not match source TS ($SOURCE_VERSION)." >&2
  echo "   Likely cause: stale tsc build cache. Try: rm extension/types/index.js && bash install.sh" >&2
  exit 1
fi
echo "ok"
`;
}

function makeFixture({ sourceVersion, compiledVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-script-test-'));
  const srcTypes = path.join(dir, 'extension', 'src', 'types');
  const outTypes = path.join(dir, 'extension', 'types');
  mkdirSync(srcTypes, { recursive: true });
  mkdirSync(outTypes, { recursive: true });
  if (sourceVersion !== null) {
    writeFileSync(
      path.join(srcTypes, 'index.ts'),
      `export const STATE_MANAGER_DEFAULTS = {\n  schemaVersion: ${sourceVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(srcTypes, 'index.ts'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  if (compiledVersion !== null) {
    writeFileSync(
      path.join(outTypes, 'index.js'),
      `export const STATE_MANAGER_DEFAULTS = {\n    schemaVersion: ${compiledVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(outTypes, 'index.js'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildFixtureScript(dir), { mode: 0o755 });
  return { dir, scriptPath };
}

function buildVersionGuardFixtureScript(scriptDir) {
  const header = `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"

ALLOW_DOWNGRADE=0
for arg in "$@"; do
  case "$arg" in
    --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
  esac
done

`;
  // Spliced in as a plain string (not a template literal) so the real
  // compare_semver's "${...}" parameter expansions are not re-interpreted
  // as JS template substitutions. No hand-copied fixture — see R-ISVP.
  const compareSemverSource = extractCompareSemverSource();
  const footer = `

read_package_version() {
  local package_json="$1"
  local version
  version="$(jq -r '.version' "$package_json")"
  if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "Could not read version from $package_json" >&2
    exit 1
  fi
  echo "$version"
}

SRC_V="$(read_package_version "$SCRIPT_DIR/extension/package.json")"
DEPLOYED_PACKAGE_JSON="$EXTENSION_ROOT/extension/package.json"
if [ -f "$DEPLOYED_PACKAGE_JSON" ]; then
  DEP_V="$(read_package_version "$DEPLOYED_PACKAGE_JSON")"
  if ! cmp="$(compare_semver "$SRC_V" "$DEP_V")"; then
    exit 1
  elif [ "$cmp" -lt 0 ] && [ "$ALLOW_DOWNGRADE" -ne 1 ]; then
    echo "REFUSE: source v$SRC_V older than deployed v$DEP_V" >&2
    exit 1
  fi
fi

if [ -d "$SCRIPT_DIR/.git" ]; then
  INSTALL_MODE="git"
else
  INSTALL_MODE="tarball"
fi
echo "mode=$INSTALL_MODE"
`;
  return header + compareSemverSource + footer;
}

function makeVersionGuardFixture({ sourceVersion, deployedVersion, gitMode }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-version-guard-'));
  const homeDir = path.join(dir, 'home');
  const sourceExtension = path.join(dir, 'extension');
  const deployedExtension = path.join(homeDir, '.claude', 'pickle-rick', 'extension');
  mkdirSync(sourceExtension, { recursive: true });
  mkdirSync(deployedExtension, { recursive: true });
  if (gitMode) {
    mkdirSync(path.join(dir, '.git'));
  }
  writeFileSync(path.join(sourceExtension, 'package.json'), JSON.stringify({ version: sourceVersion }));
  writeFileSync(path.join(deployedExtension, 'package.json'), JSON.stringify({ version: deployedVersion }));
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildVersionGuardFixtureScript(dir), { mode: 0o755 });
  return { dir, homeDir, scriptPath };
}

function runVersionGuardFixture(fixture, args = []) {
  return spawnSync('bash', [fixture.scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
}

function buildWorktreeGuardFixtureScript() {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

check_worktree_head_fresh() {
  local inside_work_tree wt_top WT_HEAD
  inside_work_tree="$(git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)"
  [ "$inside_work_tree" = "true" ] || return 0

  wt_top="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  case "$wt_top" in
    */.claude/worktrees/agent-*) ;;
    *) return 0 ;;
  esac

  WT_HEAD="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"
  if ! git -C "$SCRIPT_DIR" merge-base --is-ancestor origin/main HEAD; then
    echo "REFUSE: worktree HEAD $WT_HEAD predates main; pull main first" >&2
    exit 1
  fi
}

check_worktree_head_fresh
echo "ok"
`;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed in ${cwd}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function writeWorktreeGuardScript(dir) {
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildWorktreeGuardFixtureScript(), { mode: 0o755 });
  return scriptPath;
}

function makeWorktreeGuardFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-worktree-guard-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['checkout', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'pickle-rick@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Pickle Rick Tests']);

  writeFileSync(path.join(repo, 'tracked.txt'), 'old\n');
  runGit(repo, ['add', 'tracked.txt']);
  runGit(repo, ['commit', '-m', 'old']);
  const oldHead = runGit(repo, ['rev-parse', 'HEAD']);

  writeFileSync(path.join(repo, 'tracked.txt'), 'current\n');
  runGit(repo, ['add', 'tracked.txt']);
  runGit(repo, ['commit', '-m', 'current']);
  const currentHead = runGit(repo, ['rev-parse', 'HEAD']);
  runGit(repo, ['update-ref', 'refs/remotes/origin/main', currentHead]);

  const worktreesDir = path.join(repo, '.claude', 'worktrees');
  const staleWorktree = path.join(worktreesDir, 'agent-stale');
  const currentWorktree = path.join(worktreesDir, 'agent-current');
  runGit(repo, ['worktree', 'add', '--detach', staleWorktree, oldHead]);
  runGit(repo, ['worktree', 'add', '--detach', currentWorktree, currentHead]);

  return {
    dir,
    repo,
    staleScript: writeWorktreeGuardScript(staleWorktree),
    currentScript: writeWorktreeGuardScript(currentWorktree),
    mainScript: writeWorktreeGuardScript(repo),
  };
}

function runWorktreeGuardScript(scriptPath) {
  return spawnSync('bash', [scriptPath], { encoding: 'utf8' });
}

function buildCacheHygieneFixtureScript(scriptDir) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"

read_package_version() {
  local package_json="$1"
  local version
  version="$(jq -r '.version' "$package_json")"
  if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "Could not read version from $package_json" >&2
    exit 1
  fi
  echo "$version"
}

mkdir -p "$EXTENSION_ROOT/extension"
rsync -a --delete "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"

DEPLOYED_V="$(read_package_version "$EXTENSION_ROOT/extension/package.json")"
UPDATE_CACHE_FILE="$EXTENSION_ROOT/update-check.json"
if [ -f "$UPDATE_CACHE_FILE" ]; then
  CACHE_CURRENT_VERSION="$(jq -r '.current_version // ""' "$UPDATE_CACHE_FILE" 2>/dev/null || echo "")"
  if [ "$CACHE_CURRENT_VERSION" = "1.0.0" ] || [ "$CACHE_CURRENT_VERSION" != "$DEPLOYED_V" ]; then
    rm -f "$UPDATE_CACHE_FILE"
    echo "[install.sh] Removed stale update cache: cached current_version=\${CACHE_CURRENT_VERSION:-<missing>} deployed=$DEPLOYED_V" >&2
  fi
fi
`;
}

function makeCacheHygieneFixture({ sourceVersion, cacheVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-cache-hygiene-'));
  const homeDir = path.join(dir, 'home');
  const sourceExtension = path.join(dir, 'extension');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  mkdirSync(sourceExtension, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(path.join(sourceExtension, 'package.json'), JSON.stringify({ version: sourceVersion }));
  writeFileSync(path.join(runtimeRoot, 'update-check.json'), JSON.stringify({
    last_check_epoch: 1,
    latest_version: cacheVersion,
    current_version: cacheVersion,
  }));
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildCacheHygieneFixtureScript(dir), { mode: 0o755 });
  return {
    dir,
    homeDir,
    scriptPath,
    cachePath: path.join(runtimeRoot, 'update-check.json'),
  };
}

function runCacheHygieneFixture(fixture) {
  return spawnSync('bash', [fixture.scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
}

// The MANAGED_KEYS jq transform, extracted verbatim so it can be asserted
// byte-identical against the real install.sh jq expression (R2 lockstep).
const MANAGED_KEYS_JQ_EXPR = 'del(.worker_test_gate_timeout_ms) | .codegraph.enabled = true | .codegraph.index_at_setup = true | .codegraph.expose_mcp_to_workers = true | .auto_update_enabled = false';

function buildKillSwitchForceFixtureScript(scriptDir) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"

mkdir -p "$EXTENSION_ROOT"
if [ -f "$EXTENSION_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \\
    && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"
else
  cp "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/"
fi

# --- MANAGED_KEYS: force code-owned settings source-authoritative ---
_managed_before_timeout="$(jq -r 'if .worker_test_gate_timeout_ms == null then "null" else (.worker_test_gate_timeout_ms | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_enabled="$(jq -r 'if .codegraph.enabled == null then "null" else (.codegraph.enabled | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_setup="$(jq -r 'if .codegraph.index_at_setup == null then "null" else (.codegraph.index_at_setup | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_expose="$(jq -r 'if .codegraph.expose_mcp_to_workers == null then "null" else (.codegraph.expose_mcp_to_workers | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_auto_update="$(jq -r 'if .auto_update_enabled == null then "null" else (.auto_update_enabled | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"

TMPFILE="$(mktemp)"
jq '${MANAGED_KEYS_JQ_EXPR}' \\
  "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \\
  && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"

if [ "$_managed_before_timeout" != "null" ]; then
  echo "[install.sh] MANAGED_KEYS forced worker_test_gate_timeout_ms: \${_managed_before_timeout} -> deleted" >&2
fi
if [ "$_managed_before_cg_enabled" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.enabled: \${_managed_before_cg_enabled} -> true" >&2
fi
if [ "$_managed_before_cg_setup" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.index_at_setup: \${_managed_before_cg_setup} -> true" >&2
fi
if [ "$_managed_before_cg_expose" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.expose_mcp_to_workers: \${_managed_before_cg_expose} -> true" >&2
fi
if [ "$_managed_before_auto_update" != "false" ]; then
  echo "[install.sh] MANAGED_KEYS forced auto_update_enabled: \${_managed_before_auto_update} -> false" >&2
fi
`;
}

function makeKillSwitchForceFixture({ deployedAutoUpdateEnabled, deployedTimeoutMs, deployedCodegraph }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-kill-switch-force-'));
  const homeDir = path.join(dir, 'home');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  const sourceSettingsPath = path.join(dir, 'pickle_settings.json');
  const deployedSettingsPath = path.join(runtimeRoot, 'pickle_settings.json');
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(sourceSettingsPath, JSON.stringify({
    auto_update_enabled: false,
    default_max_iterations: 500,
    source_only: 'kept',
  }, null, 2));
  if (deployedAutoUpdateEnabled !== null) {
    const deployed = {
      auto_update_enabled: deployedAutoUpdateEnabled,
      user_only: 'preserved',
    };
    if (deployedTimeoutMs !== undefined) { deployed.worker_test_gate_timeout_ms = deployedTimeoutMs; }
    if (deployedCodegraph !== undefined) { deployed.codegraph = deployedCodegraph; }
    writeFileSync(deployedSettingsPath, JSON.stringify(deployed, null, 2));
  }
  const sourceBefore = readFileSync(sourceSettingsPath, 'utf8');
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildKillSwitchForceFixtureScript(dir), { mode: 0o755 });
  return {
    dir,
    homeDir,
    scriptPath,
    sourceSettingsPath,
    deployedSettingsPath,
    sourceBefore,
  };
}

function runKillSwitchForceFixture(fixture) {
  return spawnSync('bash', [fixture.scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function buildActiveSessionFixtureScript() {
  return `#!/bin/bash
set -euo pipefail
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
OVERRIDE_ACTIVE=0
CLOSER_CONTEXT=0
for arg in "$@"; do
  case "$arg" in
    --override-active) OVERRIDE_ACTIVE=1 ;;
    --closer-context) CLOSER_CONTEXT=1 ;;
  esac
done

write_active_session_bypass_audit() {
  local session_id="$1"
  local state_file="$2"
  jq -nc \
    --arg event "INSTALL_BYPASS_ACTIVE_SESSION" \
    --arg timestamp "2026-05-02T00:00:00Z" \
    --arg session_id "$session_id" \
    --arg state_file "$state_file" \
    --arg override_active "$OVERRIDE_ACTIVE" \
    --arg closer_context "$CLOSER_CONTEXT" \
    '{
      event: $event,
      timestamp: $timestamp,
      session_id: $session_id,
      state_file: $state_file,
      override_active: ($override_active == "1"),
      closer_context: ($closer_context == "1")
    }' >> "$EXTENSION_ROOT/deploy-audit.log"
}

check_active_sessions() {
  local data_root sessions_root state_file active session_id
  data_root="\${PICKLE_DATA_ROOT:-$HOME/.local/share/pickle-rick}"
  sessions_root="$data_root/sessions"
  [ -d "$sessions_root" ] || return 0

  for state_file in "$sessions_root"/*/state.json; do
    [ -e "$state_file" ] || return 0
    if ! active="$(jq -r 'if .active == true then "true" else "false" end' "$state_file" 2>/dev/null)"; then
      echo "WARNING: malformed state.json skipped: $state_file" >&2
      continue
    fi
    [ "$active" = "true" ] || continue

    session_id="$(jq -r '.session_id // empty' "$state_file" 2>/dev/null || true)"
    [ -n "$session_id" ] || session_id="$(basename "$(dirname "$state_file")")"

    if [ "$OVERRIDE_ACTIVE" -eq 1 ] || [ "$CLOSER_CONTEXT" -eq 1 ]; then
      write_active_session_bypass_audit "$session_id" "$state_file"
      return 0
    fi

    echo "REFUSE: active session $session_id — kill the pipeline first or pass --override-active" >&2
    exit 2
  done
}

mkdir -p "$EXTENSION_ROOT"
check_active_sessions
echo "ok"
`;
}

function makeActiveSessionFixture({ stateContent, sessionDirName = 'session-active' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-active-session-'));
  const homeDir = path.join(dir, 'home');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  const dataRoot = path.join(dir, 'data-root');
  const sessionDir = path.join(dataRoot, 'sessions', sessionDirName);
  mkdirSync(sessionDir, { recursive: true });
  if (stateContent !== null) {
    writeFileSync(path.join(sessionDir, 'state.json'), stateContent);
  }
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildActiveSessionFixtureScript(), { mode: 0o755 });
  return {
    dir,
    homeDir,
    runtimeRoot,
    dataRoot,
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    auditPath: path.join(runtimeRoot, 'deploy-audit.log'),
    scriptPath,
  };
}

function runActiveSessionFixture(fixture, args = []) {
  return spawnSync('bash', [fixture.scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir, PICKLE_DATA_ROOT: fixture.dataRoot },
  });
}

function readAuditLine(fixture) {
  return JSON.parse(readFileSync(fixture.auditPath, 'utf8').trim().split('\n')[0]);
}

describe('install.sh active-session guard', () => {
  test('install-script.active-session-refused refuses when session is active', () => {
    const fixture = makeActiveSessionFixture({
      stateContent: JSON.stringify({ session_id: 'active-abc123', active: true }),
    });
    try {
      const result = runActiveSessionFixture(fixture);
      assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}`);
      assert.match(
        result.stderr,
        /REFUSE: active session active-abc123 — kill the pipeline first or pass --override-active/,
      );
      assert.equal(existsSync(fixture.auditPath), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.override-active bypasses active session and writes audit log', () => {
    const fixture = makeActiveSessionFixture({
      stateContent: JSON.stringify({ session_id: 'active-override', active: true }),
    });
    try {
      const result = runActiveSessionFixture(fixture, ['--override-active']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      const audit = readAuditLine(fixture);
      assert.equal(audit.event, 'INSTALL_BYPASS_ACTIVE_SESSION');
      assert.equal(audit.session_id, 'active-override');
      assert.equal(audit.override_active, true);
      assert.equal(audit.closer_context, false);
      assert.equal(audit.state_file, fixture.statePath);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.closer-context-active bypasses active session and writes audit log', () => {
    const fixture = makeActiveSessionFixture({
      stateContent: JSON.stringify({ session_id: 'active-closer', active: true }),
    });
    try {
      const result = runActiveSessionFixture(fixture, ['--closer-context']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      const audit = readAuditLine(fixture);
      assert.equal(audit.event, 'INSTALL_BYPASS_ACTIVE_SESSION');
      assert.equal(audit.session_id, 'active-closer');
      assert.equal(audit.override_active, false);
      assert.equal(audit.closer_context, true);
      assert.equal(audit.state_file, fixture.statePath);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.active-session-malformed-state skips malformed state json', () => {
    const fixture = makeActiveSessionFixture({ stateContent: '{not valid json!!!' });
    try {
      const result = runActiveSessionFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.match(result.stderr, /WARNING: malformed state[.]json skipped:/);
      assert.equal(existsSync(fixture.auditPath), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains active-session refusal and downgrade audit schema', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(src.includes('--override-active'), 'install.sh must parse --override-active');
    assert.ok(src.includes('--closer-context'), 'install.sh must parse --closer-context');
    assert.ok(
      src.includes('REFUSE: active session $session_id — kill the pipeline first or pass --override-active'),
      'install.sh must contain the active-session refusal contract',
    );
    assert.ok(
      src.includes('--arg event "DOWNGRADE"'),
      'install.sh must write the downgrade audit event',
    );
    assert.ok(src.includes('deploy-audit.log'), 'install.sh must append downgrade evidence to deploy-audit.log');
  });

  test('R-ITS-5-MIN: install.sh refuses ALL invocations during active session, not just downgrades', () => {
    // Pre-fix the active-session guard fired only inside handle_allowed_downgrade
    // — a non-downgrade install.sh during a live bundle replaced compiled JS
    // while the running mux-runner held old code in-memory. R-ITS-5-MIN moves
    // the guard to the top of install.sh so it covers every invocation.
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('# --- ACTIVE-BUNDLE GUARD (R-ITS-5-MIN) ---'),
      'install.sh must contain the R-ITS-5-MIN guard banner',
    );
    assert.ok(
      src.includes('install.sh blocked — active session'),
      'install.sh must contain the new R-ITS-5-MIN refusal message',
    );
    // The guard must run BEFORE the validation phase (which compiles + rsyncs);
    // assert ordering by line number.
    const guardLine = src.split('\n').findIndex((line) => line.includes('ACTIVE-BUNDLE GUARD'));
    const validationLine = src.split('\n').findIndex((line) => line.includes('# --- VALIDATION ---'));
    assert.ok(guardLine > 0, 'guard banner must exist');
    assert.ok(validationLine > 0, 'validation banner must exist');
    assert.ok(
      guardLine < validationLine,
      `R-ITS-5-MIN guard (line ${guardLine + 1}) must precede VALIDATION (line ${validationLine + 1}) so the refuse fires before compile/rsync`,
    );
  });
});

describe('install.sh deploy parity sampler stripped', () => {
  test('real install.sh contains no deploy parity sampler hooks', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.doesNotMatch(src, /crontab/, 'install.sh must not invoke crontab');
    assert.doesNotMatch(src, /deploy-baseline[.]json/, 'install.sh must not write deploy-baseline.json');
    assert.doesNotMatch(src, /verify-deploy-parity[.]js/, 'install.sh must not reference deploy parity sampler');
    assert.doesNotMatch(src, /--uninstall-cron/, 'install.sh must not support --uninstall-cron');
    assert.ok(
      src.includes('DEPLOYED_V="$(read_package_version "$EXTENSION_ROOT/extension/package.json")"'),
      'install.sh must still read deployed version for cache hygiene',
    );
    assert.ok(src.includes('REFUSE: source v$SRC_V older than deployed v$DEP_V'), 'install.sh must keep downgrade guard');
  });
});

describe('install.sh worktree freshness guard', () => {
  test('install-script.worktree-stale refuses stale agent worktree', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.staleScript);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: worktree HEAD [0-9a-f]+ predates main; pull main first/);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.worktree-current permits current agent worktree', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.currentScript);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.worktree-main permits normal main checkout', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.mainScript);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh kill-switch force-write', () => {
  test('install-script.kill-switch-force deployed-true-merge-false', () => {
    const fixture = makeKillSwitchForceFixture({ deployedAutoUpdateEnabled: true });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const deployedSettings = readJson(fixture.deployedSettingsPath);
      assert.equal(deployedSettings.auto_update_enabled, false);
      assert.equal(deployedSettings.user_only, 'preserved');
      assert.equal(deployedSettings.source_only, 'kept');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.kill-switch-force deployed-false-stays-false', () => {
    const fixture = makeKillSwitchForceFixture({ deployedAutoUpdateEnabled: false });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const deployedSettings = readJson(fixture.deployedSettingsPath);
      assert.equal(deployedSettings.auto_update_enabled, false);
      assert.equal(deployedSettings.user_only, 'preserved');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.kill-switch-force source-settings-unchanged', () => {
    const fixture = makeKillSwitchForceFixture({ deployedAutoUpdateEnabled: true });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(readFileSync(fixture.sourceSettingsPath, 'utf8'), fixture.sourceBefore);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

function extractManagedKeysJqFromInstallSh() {
  const src = readFileSync(INSTALL_SH, 'utf8');
  const marker = '# --- MANAGED_KEYS: force code-owned settings source-authoritative ---';
  const idx = src.indexOf(marker);
  if (idx === -1) { throw new Error('MANAGED_KEYS marker not found in install.sh'); }
  const match = src.slice(idx).match(/jq '([^']*)'/);
  if (!match) { throw new Error('MANAGED_KEYS jq expression not found in install.sh'); }
  return match[1];
}

describe('install.sh MANAGED_KEYS force (source-authoritative)', () => {
  // AC-GTRUTH-B3-1 (upgrade path: deployed enabled=false -> true) and AC-GTRUTH-B3-2
  // (every sibling tunable survives) are asserted here together, because they are two
  // halves of one claim about the SAME MANAGED_KEYS pass: it forces exactly the three
  // codegraph booleans and touches nothing else in the codegraph block.
  //
  // Every sibling below is seeded with a value DIFFERENT from the source default
  // (index_timeout_ms 120000 / sync 30000 / query 5000 / staleness 30 / context 8192), so a
  // regression that overwrote the whole codegraph block with source values would be caught.
  // Seeding them at the defaults would let that regression pass by coincidence.
  //
  // `expose_mcp_to_workers` is seeded false and forced true: as of e99b172b it is the FIFTH
  // managed key, so the C7 worker-MCP lane is source-authoritative rather than inheriting a
  // stale deployed false. The survivor set below is what MANAGED_KEYS must NOT touch.
  test('AC-GTRUTH-B3-1/B3-2 (AC-SSAT-3/6): strips timeout, forces codegraph on, preserves EVERY sibling tunable', () => {
    const deployedCodegraph = {
      enabled: false,
      index_at_setup: false,
      index_timeout_ms: 111000,
      sync_timeout_ms: 22000,
      query_timeout_ms: 3300,
      staleness_max_age_minutes: 15,
      context_max_bytes: 4444,
      expose_mcp_to_workers: false,
    };
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: true,
      deployedTimeoutMs: 240000,
      deployedCodegraph,
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const deployedSettings = readJson(fixture.deployedSettingsPath);
      assert.equal('worker_test_gate_timeout_ms' in deployedSettings, false);

      // AC-GTRUTH-B3-1 — the upgrade path, not just a fresh install.
      assert.equal(deployedSettings.codegraph.enabled, true);
      assert.equal(deployedSettings.codegraph.index_at_setup, true);
      assert.equal(deployedSettings.codegraph.expose_mcp_to_workers, true);

      // AC-GTRUTH-B3-2 — the exhaustive survivor set, asserted as a whole object so a key
      // ADDED to the forced set is caught too. A per-key sweep would miss that.
      assert.deepEqual(
        deployedSettings.codegraph,
        { ...deployedCodegraph, enabled: true, index_at_setup: true, expose_mcp_to_workers: true },
        'MANAGED_KEYS must force exactly codegraph.enabled, codegraph.index_at_setup and '
        + 'codegraph.expose_mcp_to_workers. Any other difference means it now overwrites an '
        + 'operator tunable — the per-field jq has regressed to a whole-block `.codegraph = {...}` '
        + 'assignment, which silently destroys staleness/context/timeout settings.',
      );

      assert.equal(deployedSettings.auto_update_enabled, false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-SSAT-8: fresh install (no deployed file) still forces managed keys', () => {
    const fixture = makeKillSwitchForceFixture({ deployedAutoUpdateEnabled: null });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const deployedSettings = readJson(fixture.deployedSettingsPath);
      assert.equal('worker_test_gate_timeout_ms' in deployedSettings, false);
      assert.equal(deployedSettings.codegraph.enabled, true);
      assert.equal(deployedSettings.codegraph.index_at_setup, true);
      assert.equal(deployedSettings.auto_update_enabled, false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-GTRUTH-B3-3 (AC-SSAT-9): differing deployed value emits an observability line', () => {
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: false,
      deployedCodegraph: { enabled: false, index_at_setup: true },
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stderr, /MANAGED_KEYS forced codegraph\.enabled: false -> true/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  // Every forced codegraph boolean must be seeded on the DEPLOYED side here. The fixture's
  // source settings are a synthetic literal with no `codegraph` block at all (see
  // makeKillSwitchForceFixture), so the repo's own pickle_settings.json defaults never reach
  // this merge — an unseeded key reads back `null`, trips its `!= "true"` guard, and emits the
  // very line this test asserts is absent.
  test('AC-SSAT-9: already-matching deployed values emit no observability line', () => {
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: false,
      deployedCodegraph: { enabled: true, index_at_setup: true, expose_mcp_to_workers: true },
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /MANAGED_KEYS forced/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-SSAT-4: resolver returns compiled default off the produced file', () => {
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: true,
      deployedTimeoutMs: 240000,
      deployedCodegraph: { enabled: true, index_at_setup: true },
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const producedRoot = path.dirname(fixture.deployedSettingsPath);
      assert.equal(resolveWorkerTestGateTimeoutMs(producedRoot, undefined, {}), 600_000);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-SSAT-5: env override wins and floor is env-only', () => {
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: true,
      deployedTimeoutMs: 240000,
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const producedRoot = path.dirname(fixture.deployedSettingsPath);
      assert.equal(resolveWorkerTestGateTimeoutMs(producedRoot, null, { PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '30000' }), 60_000);
      assert.equal(resolveWorkerTestGateTimeoutMs(producedRoot, null, { PICKLE_WORKER_TEST_FAST_TIMEOUT_MS: '600000' }), 600_000);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  // AC-1 (e99b172b) — the UPGRADE path is the whole defect, so it is tested on its own rather
  // than folded into the fresh-install case. install.sh merges settings with
  // `jq -s '.[0] * .[1]' <source> <deployed>`: the DEPLOYED file is the right operand, and jq's
  // `*` gives the right operand per-key priority. So a deployed `expose_mcp_to_workers: false`
  // beats a flipped source default, and flipping source alone is inert after a deploy. Only the
  // MANAGED_KEYS force overrides it. A fresh-install-only test (no deployed file) never exercises
  // that merge and would pass even with the force deleted.
  test('AC-1: deployed expose_mcp_to_workers=false is forced true on upgrade, siblings survive', () => {
    // Siblings seeded AWAY from the source defaults (120000/30000/5000/30/8192) so a regression
    // to a whole-block `.codegraph = {...}` assignment — which would reinstate source values —
    // is caught. Seeding them at their defaults would let that regression pass by coincidence.
    const deployedCodegraph = {
      enabled: true,
      index_at_setup: true,
      index_timeout_ms: 111000,
      sync_timeout_ms: 22000,
      query_timeout_ms: 3300,
      staleness_max_age_minutes: 15,
      context_max_bytes: 4444,
      expose_mcp_to_workers: false,
    };
    const fixture = makeKillSwitchForceFixture({
      deployedAutoUpdateEnabled: false,
      deployedCodegraph,
    });
    try {
      const result = runKillSwitchForceFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const deployedSettings = readJson(fixture.deployedSettingsPath);

      // The AC-1 core: deployed said false, deploy must read true.
      assert.equal(
        deployedSettings.codegraph.expose_mcp_to_workers,
        true,
        'a pre-existing deployed `false` must not survive the deploy — if it does, the C7 '
        + 'worker-MCP flip is inert and buildWorkerMcpConfig stays on the passthrough branch.',
      );

      // Sibling-survival pin: the documented hazard of this force is a whole-block assignment.
      // Compared as a whole object rather than key-by-key so a DROPPED or ADDED sibling fails too.
      assert.deepEqual(
        deployedSettings.codegraph,
        { ...deployedCodegraph, expose_mcp_to_workers: true },
        'expose_mcp_to_workers must be the ONLY key this force changes; every sibling tunable '
        + 'must survive at its deployed value.',
      );

      assert.match(
        result.stderr,
        /MANAGED_KEYS forced codegraph\.expose_mcp_to_workers: false -> true/,
        'the forced transition must be observable in the deploy log, same shape as its siblings',
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('R2 lockstep: fixture jq matches the real install.sh MANAGED_KEYS jq', () => {
    assert.equal(extractManagedKeysJqFromInstallSh(), MANAGED_KEYS_JQ_EXPR);
  });
});

describe('install.sh update cache hygiene', () => {
  test('install-script.cache-hygiene removes mismatched update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.65.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.match(result.stderr, /Removed stale update cache/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.cache-hygiene removes sentinel update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.0.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.match(result.stderr, /current_version=1[.]0[.]0/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.cache-hygiene keeps matching update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.68.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), true);
      assert.equal(JSON.parse(readFileSync(fixture.cachePath, 'utf8')).current_version, '1.68.0');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh source-vs-deployed package version guard', () => {
  test('install-script.refuses-source-older git mode', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: true,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: source v1[.]62[.]0 older than deployed v1[.]67[.]0/);
      assert.doesNotMatch(result.stdout, /mode=/, 'guard must run before INSTALL_MODE branch side effects');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.refuses-source-older tarball mode', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: source v1[.]62[.]0 older than deployed v1[.]67[.]0/);
      assert.doesNotMatch(result.stdout, /mode=/, 'guard must run before INSTALL_MODE branch side effects');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.allow-downgrade permits older source', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture, ['--allow-downgrade']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /mode=tarball/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script permits same source and deployed version', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.67.0',
      deployedVersion: '1.67.0',
      gitMode: true,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /mode=git/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains unconditional source-vs-deployed guard before mode detection', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const guardIdx = src.indexOf('REFUSE: source v$SRC_V older than deployed v$DEP_V');
    const modeIdx = src.indexOf('# --- MODE DETECTION ---');
    assert.match(src, /set -euo pipefail/, 'install.sh must use strict shell options');
    assert.ok(guardIdx !== -1, 'install.sh must contain source-vs-deployed refusal');
    assert.ok(modeIdx !== -1, 'install.sh must contain mode detection marker');
    assert.ok(guardIdx < modeIdx, 'source-vs-deployed guard must run before INSTALL_MODE detection');
  });

  test('install-script.refuses-older-prerelease-source (R-ISVP)', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '2.0.0-beta.30',
      deployedVersion: '2.0.0-beta.31',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: source v2[.]0[.]0-beta[.]30 older than deployed v2[.]0[.]0-beta[.]31/);
      assert.doesNotMatch(result.stdout, /mode=/, 'guard must run before INSTALL_MODE branch side effects');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.allow-downgrade permits older prerelease source (R-ISVP)', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '2.0.0-beta.30',
      deployedVersion: '2.0.0-beta.31',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture, ['--allow-downgrade']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /mode=tarball/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('extracted compare_semver source is the live prerelease-aware function, not a frozen copy', () => {
    const extracted = extractCompareSemverSource();
    assert.match(extracted, /^compare_semver\(\) \{[\s\S]*\}$/, 'extraction must be a balanced function body');
    assert.match(extracted, /a_ident/, 'extracted source must be the prerelease-aware implementation');
    assert.match(extracted, /b_ident/, 'extracted source must be the prerelease-aware implementation');
  });
});

describe('install.sh schemaVersion parity check (F3)', () => {
  test('install.sh aborts if compiled JS schemaVersion differs from source TS', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 2 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
      assert.match(
        result.stderr,
        /schemaVersion/,
        `expected stderr to mention schemaVersion, got: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /\(2\).*\(3\)/s,
        `expected stderr to surface mismatched versions, got: ${result.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh passes when source and compiled schemaVersion match', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh aborts when schemaVersion is missing from either file', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: null, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Could not extract schemaVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains the F3 schemaVersion parity check', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(src, /SOURCE_VERSION=.*schemaVersion/, 'install.sh must extract SOURCE_VERSION from src TS');
    assert.match(src, /COMPILED_VERSION=.*schemaVersion/, 'install.sh must extract COMPILED_VERSION from compiled JS');
    assert.match(src, /Compiled JS schemaVersion .* does not match source TS/);
  });

  test('git-mode detection uses -e, not -d: in a worktree .git is a FILE', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    // A git WORKTREE's .git is a `gitdir:` POINTER FILE, not a directory. `[ -d ]` fell through to
    // tarball mode there, which skips the codegraph symlinks and lets the deploy-root
    // `npm install --omit=dev` prune the typescript symlink — leaving the deployed pipeline-runner
    // unloadable (ERR_MODULE_NOT_FOUND). Loud in tests, SILENT for an operator installing from a
    // worktree. Nothing covered this until a v2.1 gate run happened to execute inside one.
    assert.match(src, /if \[ -e "\$SCRIPT_DIR\/\.git" \]; then/,
      'install.sh must detect git mode with [ -e ] so a worktree .git FILE still means git mode');
    assert.equal(/if \[ -d "\$SCRIPT_DIR\/\.git" \]; then/.test(src), false,
      '[ -d ] misdetects a git worktree as a tarball install');
  });

  test('real source TS and compiled JS schemaVersion currently agree', () => {
    const tsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'src', 'types', 'index.ts'), 'utf8');
    const jsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'types', 'index.js'), 'utf8');
    const tsMatch = tsSrc.match(/schemaVersion:\s*(\d+)/);
    const jsMatch = jsSrc.match(/schemaVersion:\s*(\d+)/);
    assert.ok(tsMatch, 'source TS must declare schemaVersion');
    assert.ok(jsMatch, 'compiled JS must declare schemaVersion');
    assert.strictEqual(
      tsMatch[1],
      jsMatch[1],
      `source TS schemaVersion ${tsMatch[1]} must match compiled JS schemaVersion ${jsMatch[1]} — run bash install.sh to recompile`,
    );
  });
});

describe('install.sh Forward Fix F2: lock serialization', () => {
  test('install.sh contains the lock block', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('LOCKFILE="$EXTENSION_ROOT/.install.lock"'),
      'install.sh must declare a lockfile under $EXTENSION_ROOT',
    );
    assert.ok(
      src.includes('flock -x'),
      'install.sh must attempt an exclusive flock when flock(1) is available',
    );
    assert.ok(
      src.includes('mkdir "$LOCKDIR"'),
      'install.sh must include a mkdir-based lock fallback for systems without flock',
    );
  });

  test('install.sh has a --dry-run guard after the lock', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    // Anchor on code, never on prose (AP-EXT-ITER55-02): the pre-fix form read
    // src.indexOf('--dry-run'), and install.sh spells the option arm
    // `--dry-ru[n]`, so the only literal match in the whole file was the
    // comment above the guard. Rewriting that comment alone reddened the pin
    // while the arm and the guard were untouched and fully functional.
    const code = src.replace(/^[ \t]*#.*$/gm, '');
    const lockIdx = code.indexOf('LOCKFILE="$EXTENSION_ROOT/.install.lock"');
    const guardIdx = code.indexOf('if [ "$DRY_RUN" -eq 1 ]');
    assert.ok(lockIdx !== -1, 'lock block missing');
    assert.ok(guardIdx !== -1, 'install.sh must gate its early exit on $DRY_RUN');
    assert.ok(
      guardIdx > lockIdx,
      '--dry-run guard must follow lock acquisition so the dry-run path still exercises serialization',
    );

    // Acceptance is proved by bash's own matcher rather than by the arm's
    // spelling, so the pin holds for `--dry-ru[n]` and a plain `--dry-run`
    // alike and still reds on a typo'd arm that accepts neither.
    const arm = /^[ \t]*(\S+)\)[ \t]*DRY_RUN=1/m.exec(code);
    assert.ok(arm, 'install.sh must set DRY_RUN=1 from a case arm');
    const probe = spawnSync(
      'bash',
      ['-c', `case "--dry-run" in ${arm[1]}) echo MATCH ;; *) echo NOMATCH ;; esac`],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(probe.stdout.trim(), 'MATCH', 'install.sh must accept --dry-run');
  });

  test('two simultaneous invocations serialize on the lock', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'install-lock-'));
    try {
      const extRoot = path.join(dir, 'pickle-rick');
      const fixture = path.join(dir, 'install.sh');

      // Minimal fixture replicating install.sh's lock block + a 2s critical
      // section. Each child prints a millisecond timestamp the moment it
      // acquires the lock; we assert the two timestamps are at least ~2s apart.
      writeFileSync(
        fixture,
        `#!/bin/bash
set -e
EXTENSION_ROOT="${extRoot}"
mkdir -p "$EXTENSION_ROOT"
LOCKFILE="$EXTENSION_ROOT/.install.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -x -n 9; then
    flock -x 9
  fi
else
  LOCKDIR="$EXTENSION_ROOT/.install.lock.d"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    sleep 0.1
  done
  trap 'rmdir "$LOCKDIR"' EXIT
fi
node -e "process.stdout.write(String(Date.now()))"
echo
sleep 2
`,
      );
      chmodSync(fixture, 0o755);

      function runChild() {
        return new Promise((resolve, reject) => {
          let out = '';
          const c = spawn('bash', [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
          c.stdout.on('data', (d) => {
            out += d.toString();
          });
          c.on('error', reject);
          c.on('close', (code) => {
            if (code !== 0) return reject(new Error(`child exited ${code}; stdout=${out}`));
            const firstLine = out.trim().split('\n')[0];
            resolve(Number(firstLine));
          });
        });
      }

      const [tA, tB] = await Promise.all([runChild(), runChild()]);
      assert.ok(Number.isFinite(tA) && Number.isFinite(tB), `bad timestamps: ${tA}, ${tB}`);
      const delta = Math.abs(tA - tB);
      // Critical section is sleep 2 (≈2000ms). Allow 200ms scheduling slack.
      assert.ok(
        delta >= 1800,
        `expected ≥1800ms between lock acquisitions (serialized), got ${delta}ms`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function buildTypescriptSymlinkFixtureScript(scriptDir, extensionRoot) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="${extensionRoot}"

mkdir -p "$EXTENSION_ROOT/extension/node_modules"
for dep in typescript; do
  if [ -d "$SCRIPT_DIR/extension/node_modules/$dep" ]; then
    ln -sfn "$SCRIPT_DIR/extension/node_modules/$dep" "$EXTENSION_ROOT/extension/node_modules/$dep"
  fi
done
echo "ok"
`;
}

function makeTypescriptSymlinkFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-typescript-symlink-'));
  const scriptDir = path.join(dir, 'source');
  const extensionRoot = path.join(dir, 'deployed');
  const tsNodeModules = path.join(scriptDir, 'extension', 'node_modules', 'typescript');
  mkdirSync(tsNodeModules, { recursive: true });
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildTypescriptSymlinkFixtureScript(scriptDir, extensionRoot), { mode: 0o755 });
  return {
    dir,
    scriptDir,
    extensionRoot,
    scriptPath,
    symlinkPath: path.join(extensionRoot, 'extension', 'node_modules', 'typescript'),
    expectedTarget: tsNodeModules,
  };
}

describe('install.sh typescript symlink', () => {
  test('install-script.typescript-symlink exists after install with correct target', () => {
    const fixture = makeTypescriptSymlinkFixture();
    try {
      const result = spawnSync('bash', [fixture.scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.ok(existsSync(fixture.symlinkPath), 'typescript symlink must exist in deployed extension/node_modules');
      assert.ok(lstatSync(fixture.symlinkPath).isSymbolicLink(), 'typescript entry must be a symlink');
      assert.strictEqual(
        readlinkSync(fixture.symlinkPath),
        fixture.expectedTarget,
        'symlink target must equal repo extension/node_modules/typescript',
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.typescript-symlink idempotent replaces stale symlink', () => {
    const fixture = makeTypescriptSymlinkFixture();
    try {
      const deployedNodeModules = path.join(fixture.extensionRoot, 'extension', 'node_modules');
      mkdirSync(deployedNodeModules, { recursive: true });
      const staleTarget = path.join(fixture.dir, 'stale-typescript');
      mkdirSync(staleTarget);
      symlinkSync(staleTarget, fixture.symlinkPath);
      assert.strictEqual(readlinkSync(fixture.symlinkPath), staleTarget, 'pre-condition: stale symlink must be installed');

      const result = spawnSync('bash', [fixture.scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.ok(existsSync(fixture.symlinkPath), 'typescript symlink must still exist after re-install');
      assert.ok(lstatSync(fixture.symlinkPath).isSymbolicLink(), 'typescript entry must remain a symlink after re-install');
      assert.strictEqual(
        readlinkSync(fixture.symlinkPath),
        fixture.expectedTarget,
        'stale symlink must be replaced with correct target on re-install',
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh codegraph runtime dep (361e8bd9)', () => {
  test('real install.sh contains the per-mode codegraph sequence + self-probe', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('CODEGRAPH RUNTIME DEP'),
      'install.sh must contain the per-mode codegraph banner',
    );
    // Git mode: scoped main package symlink.
    assert.match(
      src,
      /ln -sfn "\$_cg_src" "\$_codegraph_scope\/codegraph"/,
      'install.sh must symlink the scoped @colbymchenry/codegraph main package in git mode',
    );
    // Git mode: generic platform-binding discovery (no hardcoded darwin-arm64).
    assert.match(
      src,
      /@colbymchenry\/codegraph-\*-\*/,
      'install.sh must resolve the platform binding via a generic codegraph-<plat>-<arch> glob',
    );
    assert.doesNotMatch(
      src,
      /codegraph-darwin-arm64/,
      'install.sh must NOT hardcode the darwin-arm64 platform binding',
    );
    // Tarball mode: deploy-root npm install at the pinned version.
    assert.match(
      src,
      /npm install --omit=dev --no-save @colbymchenry\/codegraph@0\.9\.9/,
      'install.sh must npm install codegraph@0.9.9 at the deploy root in tarball mode',
    );
    // Self-probe (both modes).
    assert.match(
      src,
      /import\('@colbymchenry\/codegraph'\)\.then\(\(\)=>process\.exit\(0\),\(\)=>process\.exit\(1\)\)/,
      'install.sh must self-probe import resolution of @colbymchenry/codegraph',
    );
    assert.ok(
      src.includes('FATAL: @colbymchenry/codegraph does not resolve'),
      'install.sh must abort loudly when the codegraph probe fails',
    );
  });

  test('flat-name symlink loop does NOT mention @colbymchenry (AC-4)', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const lines = src.split('\n');
    const loopStart = lines.findIndex((l) => /for dep in typescript;/.test(l));
    assert.ok(loopStart !== -1, 'flat-name for-dep loop must exist');
    // The flat-name loop is a small fixed block ending at its `done`.
    const loopEnd = lines.findIndex((l, i) => i > loopStart && /^done$/.test(l.trim()));
    assert.ok(loopEnd !== -1 && loopEnd > loopStart, 'flat-name for-dep loop must close with done');
    const loopBody = lines.slice(loopStart, loopEnd + 1).join('\n');
    assert.doesNotMatch(
      loopBody,
      /@colbymchenry/,
      'the flat-name symlink loop must NOT carry @colbymchenry — codegraph deploys via the per-mode block',
    );
  });

  test('codegraph per-mode block runs after rsync and before the jq settings merge', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const rsyncIdx = src.indexOf('rsync -a --delete --delete-excluded');
    const codegraphIdx = src.indexOf('CODEGRAPH RUNTIME DEP');
    const jqMergeIdx = src.indexOf('Merge pickle_settings:');
    assert.ok(rsyncIdx !== -1, 'rsync block must exist');
    assert.ok(codegraphIdx !== -1, 'codegraph block must exist');
    assert.ok(jqMergeIdx !== -1, 'jq settings merge must exist');
    assert.ok(rsyncIdx < codegraphIdx, 'codegraph block must run after rsync (which deletes node_modules)');
    assert.ok(codegraphIdx < jqMergeIdx, 'codegraph block must run before the jq settings merge');
  });
});

// ---------------------------------------------------------------------------
// R-ITS-1 / R-ITS-2: parity gate tests
// ---------------------------------------------------------------------------

function buildParityProbeFixtureScript(sourceDir, deployDir) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${sourceDir}"
EXTENSION_ROOT="${deployDir}"

md5_file() {
  local f="$1"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$f" 2>/dev/null | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$f" 2>/dev/null
  else
    echo ""
  fi
}

if [ "\${INSTALL_SKIP_PARITY:-0}" != "1" ]; then
  _parity_files=(
    "types/index.js"
    "services/state-manager.js"
    "bin/spawn-morty.js"
    "bin/mux-runner.js"
    "services/pickle-utils.js"
  )
  _mismatches=()
  for _f in "\${_parity_files[@]}"; do
    _src_md5=$(md5_file "$SCRIPT_DIR/extension/$_f")
    _dst_md5=$(md5_file "$EXTENSION_ROOT/extension/$_f")
    if [ -n "$_src_md5" ] && [ -n "$_dst_md5" ] && [ "$_src_md5" != "$_dst_md5" ]; then
      _mismatches+=("$_f (src=$_src_md5 dst=$_dst_md5)")
    fi
  done
  if [ \${#_mismatches[@]} -gt 0 ]; then
    echo "FAIL: install.sh parity probe found \${#_mismatches[@]} mismatch(es):" >&2
    printf '  - %s\\n' "\${_mismatches[@]}" >&2
    exit 1
  fi
fi
echo "ok"
`;
}

function makeParityProbeFixture({ staleFile = 'types/index.js' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-parity-gate-'));
  const sourceDir = path.join(dir, 'source');
  const deployDir = path.join(dir, 'deploy');

  const hotFiles = [
    'types/index.js',
    'services/state-manager.js',
    'bin/spawn-morty.js',
    'bin/mux-runner.js',
    'services/pickle-utils.js',
  ];

  for (const f of hotFiles) {
    const srcPath = path.join(sourceDir, 'extension', f);
    const dstPath = path.join(deployDir, 'extension', f);
    mkdirSync(path.dirname(srcPath), { recursive: true });
    mkdirSync(path.dirname(dstPath), { recursive: true });
    const content = `// current content for ${f}\nexport const v = 'current';\n`;
    writeFileSync(srcPath, content);
    if (f === staleFile) {
      writeFileSync(dstPath, `// STALE content for ${f}\nexport const v = 'stale';\n`);
    } else {
      writeFileSync(dstPath, content);
    }
  }

  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildParityProbeFixtureScript(sourceDir, deployDir), { mode: 0o755 });
  return { dir, sourceDir, deployDir, scriptPath, staleFile };
}

function runParityProbeFixture(fixture, env = {}) {
  return spawnSync('bash', [fixture.scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('install.sh parity gate (R-ITS-1 / R-ITS-2)', () => {
  test('AC-ITS-01: install.sh removes .tsbuildinfo before npx tsc and contains no compiled-JS rm loop', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('extension/.tsbuildinfo'),
      'install.sh must remove .tsbuildinfo to invalidate incremental cache (R-ITS-1: prevents stale-tsc-cache drift)',
    );
    // The redundant force-clean loop (every rm'd .js was regenerated by the
    // very next tsc, per-source .ts twin verified 156/156) was deleted along
    // with the .tsconfig.json-`src/**/*.test.ts`-exclusion hazard it carried.
    // Guard against reintroduction rather than pin the deleted mechanism.
    assert.ok(
      !/rm -f "\$jsfile"/.test(src),
      'install.sh must not rm -f a per-source-file computed $jsfile — the .tsbuildinfo removal alone forces the rebuild',
    );
    assert.ok(
      !src.includes('Force-cleaning compiled JS'),
      'install.sh must not contain the deleted force-clean banner',
    );
    const lines = src.split('\n');
    const tsbuildinfoRmLine = lines.findIndex((l) => /^\s*rm -f "\$SCRIPT_DIR\/extension\/\.tsbuildinfo"/.test(l));
    const tscLine = lines.findIndex((l) => /^\s*\(cd "\$SCRIPT_DIR\/extension" && npx tsc\)/.test(l));
    assert.ok(tsbuildinfoRmLine > 0, '.tsbuildinfo rm must exist');
    assert.ok(tscLine > 0, 'npx tsc invocation line must exist');
    assert.ok(
      tsbuildinfoRmLine < tscLine,
      `.tsbuildinfo rm (line ${tsbuildinfoRmLine + 1}) → npx tsc (line ${tscLine + 1}) ordering required`,
    );
  });

  test('AC-ITS-01b: install.sh contains POST-RSYNC MD5 PARITY PROBE banner', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('POST-RSYNC MD5 PARITY PROBE'),
      'install.sh must contain the R-ITS-2 parity probe banner',
    );
    assert.ok(
      src.includes('INSTALL_SKIP_PARITY'),
      'install.sh must reference INSTALL_SKIP_PARITY escape hatch',
    );
  });

  test('AC-ITS-02 / AC-ITS-06: stale types/index.js causes exit 1 with mismatch listed', () => {
    const fixture = makeParityProbeFixture({ staleFile: 'types/index.js' });
    try {
      const result = runParityProbeFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /FAIL.*parity probe/i, 'stderr must mention FAIL and parity probe');
      assert.match(result.stderr, /types\/index\.js/, 'stale file must be named in stderr');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-ITS-03: INSTALL_SKIP_PARITY=1 skips the probe and exits 0', () => {
    const fixture = makeParityProbeFixture({ staleFile: 'types/index.js' });
    try {
      const result = runParityProbeFixture(fixture, { INSTALL_SKIP_PARITY: '1' });
      assert.strictEqual(result.status, 0, `expected exit 0 with INSTALL_SKIP_PARITY=1, got ${result.status}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.doesNotMatch(result.stderr, /FAIL.*parity probe/i, 'probe must not run when INSTALL_SKIP_PARITY=1');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('AC-ITS-06 regression: all-matching files pass probe with exit 0', () => {
    const fixture = makeParityProbeFixture({ staleFile: null });
    try {
      const result = runParityProbeFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0 when all files match, got ${result.status}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('R-ITS-2: stale non-types hot file also triggers exit 1', () => {
    const fixture = makeParityProbeFixture({ staleFile: 'services/state-manager.js' });
    try {
      const result = runParityProbeFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1 on stale state-manager.js, got ${result.status}`);
      assert.match(result.stderr, /services\/state-manager\.js/, 'stale state-manager.js must appear in stderr');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// R-PJV-6 producer pin.
//
// The trap door for `pkgjson_revert_forensic_captured` asserted for months that
// `install.sh` MUST log the event. It never did (`grep -c` = 0), and the entry's
// own ENFORCE test (install-pkgjson-version-trace.test.js) only checks that the
// event is REGISTERED — CLAUDE.md text, schema definition, `oneOf` $ref, fixture
// shape. Registration proves nothing about emission, so the suite stayed green
// with no producer named anywhere in the claim.
//
// These tests pin the two things registration cannot: that the emission exists in
// its real home, and that the trap door's install.sh claim agrees with install.sh.
describe('install.sh R-PJV-6 pkgjson forensic emission (producer pin)', () => {
  const EVENT = 'pkgjson_revert_forensic_captured';
  const CAPTURE_SH = path.join(REPO_ROOT, 'extension', 'scripts', 'capture-pkgjson-revert-forensic.sh');
  const EXT_CLAUDE_MD = path.join(REPO_ROOT, 'extension', 'CLAUDE.md');

  test('the operator-run capture script is the real producer', () => {
    const src = readFileSync(CAPTURE_SH, 'utf8');
    assert.ok(
      src.includes(EVENT),
      `${EVENT} must be emitted by extension/scripts/capture-pkgjson-revert-forensic.sh — ` +
        'it is the only producer; losing it leaves the event with none',
    );
    assert.ok(
      src.includes('log-activity.js') || src.includes('$LOG_ACTIVITY'),
      'the capture script must emit through log-activity.js',
    );
    assert.ok(
      src.includes('--gate-payload'),
      `${EVENT} requires a gate_payload (forensic_artifact_path, suspected_hypothesis, ` +
        'src_version, deployed_version) — the emission must pass --gate-payload',
    );
  });

  test('the R-PJV-6 trap door claim about install.sh matches install.sh', () => {
    const claudeMd = readFileSync(EXT_CLAUDE_MD, 'utf8');
    const entry = claudeMd.split('\n').find((l) => l.includes('R-PJV-6'));
    assert.ok(entry, 'extension/CLAUDE.md must carry an R-PJV-6 trap-door entry');

    // Does the entry assert that install.sh emits the event?
    const claimsInstallShEmits = /`install\.sh`\s+MUST\s+log\s+a\s+`pkgjson_revert_forensic_captured`/.test(entry);
    const installShEmits = readFileSync(INSTALL_SH, 'utf8').includes(EVENT);

    assert.equal(
      claimsInstallShEmits,
      installShEmits,
      claimsInstallShEmits
        ? 'R-PJV-6 claims install.sh MUST log pkgjson_revert_forensic_captured, but install.sh ' +
          'contains no such emission — implement it or correct the trap door'
        : 'install.sh emits pkgjson_revert_forensic_captured but R-PJV-6 no longer documents it — ' +
          'restore the claim so the trap door names every producer',
    );
  });
});

// AP-EXT-ITER12-01: Stop/PostToolUse/PostToolUseFailure are registered from shell literals
// built inside install.sh, so 09b89954 (--prefix) made them relocation-aware in one edit.
// PreToolUse is a verbatim jq copy of `.claude/settings.json`, so it was invisible to that
// retrofit and kept the hardcoded $HOME the source file has carried since 7d69bd7e: a
// --prefix install registered the R-WSRC write guard at a path that does not exist, node
// exited 1 with no decision JSON, and dispatch's fail-open arm approved every protected
// write. These cases drive the REAL merge block extracted from install.sh, so the pin
// cannot drift from the shipped script.
describe('install.sh PreToolUse hook root canonicalization (AP-EXT-ITER12-01)', () => {
  const LEGACY_CMD = 'node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js config-protection';
  const CANONICAL_CMD =
    'node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/hooks/dispatch.js config-protection';

  /** Extract the real PreToolUse merge block verbatim and run it over a fixture. */
  function runRealPreToolUseMerge(deployedSettings, { runs = 1 } = {}) {
    const src = readFileSync(INSTALL_SH, 'utf8').split('\n');
    const start = src.findIndex((l) => l.startsWith('# --- PRE-TOOL-USE HOOKS'));
    const end = src.findIndex((l) => l.startsWith('# --- VALIDATE result ---'));
    assert.ok(start >= 0 && end > start, 'PreToolUse merge block not found in install.sh');

    const dir = mkdtempSync(path.join(tmpdir(), 'install-ptu-'));
    try {
      mkdirSync(path.join(dir, 'src', '.claude'), { recursive: true });
      // The REAL source settings file — the thing the merge actually copies.
      writeFileSync(
        path.join(dir, 'src', '.claude', 'settings.json'),
        readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
      );
      const settingsPath = path.join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify(deployedSettings));
      const scriptPath = path.join(dir, 'run.sh');
      writeFileSync(scriptPath, [
        '#!/bin/bash',
        'set -euo pipefail',
        `SCRIPT_DIR="${path.join(dir, 'src')}"`,
        `SETTINGS_FILE="${settingsPath}"`,
        ...src.slice(start, end),
      ].join('\n'), { mode: 0o755 });

      for (let i = 0; i < runs; i++) {
        const r = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
        assert.equal(r.status, 0, `merge block failed: ${r.stderr}`);
      }
      const merged = JSON.parse(readFileSync(settingsPath, 'utf8'));
      return (merged.hooks?.PreToolUse ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('AP-EXT-ITER212-01: a fresh install registers the guard through PICKLE_INSTALL_ROOT, never a hardcoded $HOME', () => {
    const commands = runRealPreToolUseMerge({});
    assert.deepEqual(commands, [CANONICAL_CMD]);
  });

  test('AP-EXT-ITER212-01: an upgrade migrates a legacy hardcoded entry in place, not a second registration', () => {
    const commands = runRealPreToolUseMerge({
      hooks: {
        PreToolUse: [
          { matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: LEGACY_CMD }] },
        ],
      },
    });
    // Exactly one registration: migrated, not duplicated. A second (dead) entry would
    // fail open on a relocated box and double-fire on a default one.
    assert.deepEqual(commands, [CANONICAL_CMD]);
  });

  test('AP-EXT-ITER212-01: re-running the installer is idempotent (canonical form not rewritten)', () => {
    const commands = runRealPreToolUseMerge({
      hooks: {
        PreToolUse: [
          { matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: LEGACY_CMD }] },
        ],
      },
    }, { runs: 3 });
    assert.deepEqual(commands, [CANONICAL_CMD]);
  });

  test('AP-EXT-ITER212-01: a third-party PreToolUse hook is preserved untouched', () => {
    const thirdParty = 'node /opt/thirdparty/audit.js';
    const commands = runRealPreToolUseMerge({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: thirdParty }] },
        ],
      },
    });
    assert.ok(commands.includes(thirdParty), 'third-party hook must survive the merge verbatim');
    assert.ok(commands.includes(CANONICAL_CMD), 'the guard must still be registered');
  });

  test('AP-EXT-ITER212-01: every hook family install.sh registers points at the same relocatable root', () => {
    // The defect was an ASYMMETRY: three families relocation-aware, one not. Pin the
    // property, not the four spellings, so a fifth family cannot regress unseen.
    const installSh = readFileSync(INSTALL_SH, 'utf8');
    const hookCommands = [...installSh.matchAll(/'node [^']*\/extension\/[^']*'/g)].map((m) => m[0]);
    assert.ok(hookCommands.length >= 3, 'expected install.sh to build hook command literals');
    for (const cmd of hookCommands) {
      assert.match(cmd, /\$\{PICKLE_INSTALL_ROOT:-\$HOME\/\.claude\/pickle-rick\}/,
        `hook command literal is not relocation-aware: ${cmd}`);
    }
  });
});
