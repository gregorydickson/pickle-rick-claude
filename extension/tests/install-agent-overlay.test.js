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
KNOWN_AGENT_HASHES="$SCRIPT_DIR/.claude/agents/.known-hashes"
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  fi
}
is_installer_output() {
  local legacy_hash
  legacy_hash="$(file_sha256 "$1")"
  if [ -z "$legacy_hash" ]; then
    same_size_and_mtime "$1" "$2"
    return $?
  fi
  [ "$legacy_hash" = "$(file_sha256 "$2")" ] && return 0
  [ -f "$KNOWN_AGENT_HASHES" ] || return 1
  grep -q "^$3 $legacy_hash\$" "$KNOWN_AGENT_HASHES"
}
if [ -d "$SCRIPT_DIR/.claude/agents" ]; then
  mkdir -p "$AGENTS_DIR" "$MANAGED_AGENTS_DIR"
  for src_agent in "$SCRIPT_DIR"/.claude/agents/*.md; do
    [ -e "$src_agent" ] || continue
    agent_file="$(basename "$src_agent")"
    legacy_agent="$AGENTS_DIR/$agent_file"
    managed_agent="$MANAGED_AGENTS_DIR/$agent_file"
    if [ -f "$legacy_agent" ]; then
      if is_installer_output "$legacy_agent" "$src_agent" "$agent_file"; then
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
