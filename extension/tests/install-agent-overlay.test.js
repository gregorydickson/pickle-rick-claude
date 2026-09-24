// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

function makeFixture() {
  const dir = path.join(tmpdir(), `install-agent-overlay-${process.pid}-${Date.now()}`);
  const scriptDir = path.join(dir, 'repo');
  const homeDir = path.join(dir, 'home');
  mkdirSync(path.join(scriptDir, '.claude', 'agents'), { recursive: true });
  mkdirSync(path.join(homeDir, '.claude', 'agents'), { recursive: true });
  const scriptPath = path.join(dir, 'install-agents.sh');
  writeFileSync(
    scriptPath,
    `#!/bin/bash
set -e
SCRIPT_DIR="${scriptDir}"
AGENTS_DIR="$HOME/.claude/agents"
MANAGED_AGENTS_DIR="$AGENTS_DIR/.pickle-managed"
file_size() {
  stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1"
}
file_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1"
}
same_size_and_mtime() {
  [ "$(file_size "$1")" = "$(file_size "$2")" ] && [ "$(file_mtime "$1")" = "$(file_mtime "$2")" ]
}
if [ -d "$SCRIPT_DIR/.claude/agents" ]; then
  mkdir -p "$AGENTS_DIR" "$MANAGED_AGENTS_DIR"
  for src_agent in "$SCRIPT_DIR"/.claude/agents/*.md; do
    [ -e "$src_agent" ] || continue
    agent_file="$(basename "$src_agent")"
    legacy_agent="$AGENTS_DIR/$agent_file"
    managed_agent="$MANAGED_AGENTS_DIR/$agent_file"
    if [ -f "$legacy_agent" ]; then
      if same_size_and_mtime "$legacy_agent" "$src_agent"; then
        if [ -e "$managed_agent" ]; then
          rm -f "$legacy_agent"
          echo "removed duplicate $agent_file"
        else
          mv "$legacy_agent" "$managed_agent"
          echo "migrated $agent_file"
        fi
      else
        echo "legacy conflict $legacy_agent -> $MANAGED_AGENTS_DIR/$agent_file"
      fi
    fi
  done
  rsync -a "$SCRIPT_DIR/.claude/agents/" "$MANAGED_AGENTS_DIR/"
fi
`,
  );
  chmodSync(scriptPath, 0o755);
  return { dir, scriptDir, homeDir, scriptPath };
}

function writeSourceAndLegacy(scriptDir, homeDir, filename, sourceContent, legacyContent = sourceContent) {
  const sourcePath = path.join(scriptDir, '.claude', 'agents', filename);
  const legacyPath = path.join(homeDir, '.claude', 'agents', filename);
  writeFileSync(sourcePath, sourceContent);
  writeFileSync(legacyPath, legacyContent);
  // Match legacy's mtime to source so an unmodified canonical agent is detected as
  // "matching" (→ migrated). The actual Linux bug was the stat-helper order, not
  // mtime granularity — see the GNU-`-c`-first reorder in file_size/file_mtime above
  // (and the same fix in install.sh).
  const sourceStat = statSync(sourcePath);
  utimesSync(legacyPath, sourceStat.atime, sourceStat.mtime);
  return { sourcePath, legacyPath };
}

test('install-agent-overlay: real install targets .pickle-managed managed agents dir', () => {
  const src = readFileSync(INSTALL_SH, 'utf8');
  assert.match(src, /MANAGED_AGENTS_DIR="\$AGENTS_DIR\/\.pickle-managed"/);
  assert.match(src, /rsync -a "\$SCRIPT_DIR\/\.claude\/agents\/" "\$MANAGED_AGENTS_DIR\/"/);
  assert.match(src, /Legacy agent conflict preserved/);
});

// The agents rsync has no --delete, so the two removed teams-mode agents persist in the
// deployed managed dir. install.sh's own `rm -f` lines are extracted and run against a
// sandbox HOME so the assertion measures the shipped text, not a copy of it.
test('install-agent-overlay: deployed teams-mode agent residue is removed AFTER the agents rsync', () => {
  const src = readFileSync(INSTALL_SH, 'utf8');
  const rsyncIdx = src.indexOf('rsync -a "$SCRIPT_DIR/.claude/agents/" "$MANAGED_AGENTS_DIR/"');
  const residueLines = src.split('\n').filter((l) => /^\s*rm -f .*\$MANAGED_AGENTS_DIR\//.test(l));
  assert.ok(rsyncIdx > 0, 'agents rsync line not found in install.sh');
  assert.ok(residueLines.length > 0, 'install.sh has no rm -f of managed-agent residue');
  for (const line of residueLines) {
    assert.ok(src.indexOf(line) > rsyncIdx, `residue removal must follow the agents rsync: ${line}`);
  }

  const dir = path.join(tmpdir(), `install-agent-residue-${process.pid}-${Date.now()}`);
  const homeDir = path.join(dir, 'home');
  const managedDir = path.join(homeDir, '.claude', 'agents', '.pickle-managed');
  try {
    mkdirSync(managedDir, { recursive: true });
    const removed = ['morty-implementer.md', 'morty-reviewer.md'];
    for (const f of [...removed, 'morty-phase-planner.md']) writeFileSync(path.join(managedDir, f), 'deployed\n');

    const result = spawnSync('bash', ['-c', residueLines.join('\n')], {
      cwd: dir,
      env: { ...process.env, HOME: homeDir, MANAGED_AGENTS_DIR: managedDir },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(result.status, 0, result.stderr);
    for (const f of removed) assert.throws(() => statSync(path.join(managedDir, f)), `${f} should be gone`);
    assert.equal(readFileSync(path.join(managedDir, 'morty-phase-planner.md'), 'utf8'), 'deployed\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install-agent-overlay: matching legacy canonical agent migrates to .pickle-managed', () => {
  const { dir, scriptDir, homeDir, scriptPath } = makeFixture();
  try {
    writeSourceAndLegacy(scriptDir, homeDir, 'morty-implementer.md', 'canonical\n');

    const result = spawnSync('bash', [scriptPath], { cwd: dir, env: { ...process.env, HOME: homeDir }, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /migrated morty-implementer\.md/);
    assert.throws(() => statSync(path.join(homeDir, '.claude', 'agents', 'morty-implementer.md')));
    assert.equal(
      readFileSync(path.join(homeDir, '.claude', 'agents', '.pickle-managed', 'morty-implementer.md'), 'utf8'),
      'canonical\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install-agent-overlay: modified legacy top-level agent is preserved as user override', () => {
  const { dir, scriptDir, homeDir, scriptPath } = makeFixture();
  try {
    writeSourceAndLegacy(scriptDir, homeDir, 'morty-reviewer.md', 'canonical\n', 'custom user override\n');

    const result = spawnSync('bash', [scriptPath], { cwd: dir, env: { ...process.env, HOME: homeDir }, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /legacy conflict/);
    assert.equal(readFileSync(path.join(homeDir, '.claude', 'agents', 'morty-reviewer.md'), 'utf8'), 'custom user override\n');
    assert.equal(
      readFileSync(path.join(homeDir, '.claude', 'agents', '.pickle-managed', 'morty-reviewer.md'), 'utf8'),
      'canonical\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
