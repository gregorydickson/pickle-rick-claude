// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  grep -qFx -- "$3 $legacy_hash" "$KNOWN_AGENT_HASHES"
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

// The no-sha256 fallback arm of is_installer_output. Hosts without sha256sum/shasum
// revert to the size+mtime heuristic, which is the ONLY branch where the pre-provenance
// semantics still apply -- so both of its outcomes are pinned here rather than left to
// the claim in the commit message. `file_sha256` is stubbed to return empty (the exact
// signal a missing hasher produces) instead of stripping PATH, which would also remove
// the tools the migration block itself needs.
function withoutSha256(scriptPath) {
  const anchor = 'if [ -d "$SCRIPT_DIR/.claude/agents" ]; then';
  const src = readFileSync(scriptPath, 'utf8');
  assert.ok(src.includes(anchor), 'fixture script must contain the migration block anchor');
  const stubbed = src.replace(anchor, `file_sha256() { :; }\n${anchor}`);
  const stubbedPath = `${scriptPath}.nosha`;
  writeFileSync(stubbedPath, stubbed);
  chmodSync(stubbedPath, 0o755);
  return stubbedPath;
}

test('install-agent-overlay: with no sha256 tool, an unchanged legacy agent still migrates', () => {
  const { dir, scriptDir, homeDir, scriptPath } = makeFixture();
  try {
    const { legacyPath } = writeSourceAndLegacy(scriptDir, homeDir, 'morty-implementer.md', 'canonical body\n');
    const result = spawnSync('bash', [withoutSha256(scriptPath)], { cwd: dir, env: { ...process.env, HOME: homeDir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(legacyPath), false, 'size+mtime fallback must still migrate unchanged installer output');
    assert.equal(
      readFileSync(path.join(homeDir, '.claude', 'agents', '.pickle-managed', 'morty-implementer.md'), 'utf8'),
      'canonical body\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install-agent-overlay: with no sha256 tool, a superseded version is preserved, not migrated', () => {
  const { dir, scriptDir, homeDir, scriptPath } = makeFixture();
  try {
    // A real older shipped version: differs from the bytes being installed. WITH a hasher
    // the manifest recognises it and migrates; without one there is nothing to consult, so
    // the documented failure direction is under-migrate -- preserve the user's file.
    const { legacyPath } = writeSourceAndLegacy(scriptDir, homeDir, 'morty-reviewer.md', 'new shipped body\n', 'older shipped body\n');
    const result = spawnSync('bash', [withoutSha256(scriptPath)], { cwd: dir, env: { ...process.env, HOME: homeDir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(legacyPath, 'utf8'), 'older shipped body\n', 'fallback must under-migrate rather than delete');
    // NOTE: the fixture paraphrases the installer's messages ("legacy conflict" vs
    // "Legacy agent conflict preserved"), so this marker pins the FIXTURE, not shipped
    // output. The real string is asserted against real install.sh in the integration tier.
    assert.match(result.stdout, /legacy conflict /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
