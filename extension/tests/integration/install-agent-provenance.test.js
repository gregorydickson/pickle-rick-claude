// @tier: integration
//
// Regression: install.sh must migrate its OWN prior output out of the top-level
// ~/.claude/agents/ into .pickle-managed/, even when that output is an OLDER shipped
// version than the one being installed.
//
// Installs predating the overlay migration (0be35568, 2026-04-30) wrote canonical agents
// straight into ~/.claude/agents/. resolveAgentMdPath() gives a top-level file precedence
// over .pickle-managed/, so any such leftover silently outranks every later update. The
// original guard compared the legacy file's size+mtime against the CURRENT source, which
// matched only when the agent had not changed since the user's last install — i.e. only
// when there was nothing to migrate. The moment an agent was edited upstream, real
// installer output was misclassified as a user customization and preserved forever.
//
// These tests run the REAL install.sh against a fake $HOME rather than re-implementing
// the overlay block in a fixture, so they cannot drift from shipped behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const AGENTS_SRC = path.join(REPO_ROOT, '.claude', 'agents');
const MANIFEST = path.join(AGENTS_SRC, '.known-hashes');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function manifestEntries() {
  return fs
    .readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const [file, hash] = line.trim().split(/\s+/);
      return { file, hash };
    });
}

/**
 * An agent version install.sh shipped in the past whose bytes differ from the version it
 * ships today — the exact shape that the size+mtime guard could never recognise. Derived
 * from git history rather than pinned to a literal hash so it tracks the real source.
 */
function findSupersededShippedVersion() {
  const files = fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const rel = `.claude/agents/${file}`;
    const current = fs.readFileSync(path.join(AGENTS_SRC, file));
    const revs = execFileSync('git', ['rev-list', '--all', '--full-history', '--', rel], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 })
      .split('\n')
      .filter(Boolean);
    for (const rev of revs) {
      let blob;
      try {
        blob = execFileSync('git', ['cat-file', 'blob', `${rev}:${rel}`], { cwd: REPO_ROOT, maxBuffer: 1 << 24, timeout: 30_000 });
      } catch {
        continue;
      }
      if (!blob.equals(current)) return { file, content: blob, currentContent: current };
    }
  }
  return null;
}

function runInstall(homeDir) {
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  if (!fs.existsSync(path.join(homeDir, '.claude', 'settings.json'))) {
    fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');
  }
  return spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
    encoding: 'utf8',
    timeout: 600_000,
    env: {
      ...process.env,
      HOME: homeDir,
      PICKLE_INSTALL_ROOT: prefix,
      PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
    },
  });
}

test('install-agent-provenance: manifest covers every agent install.sh currently ships', () => {
  const shipped = new Set(fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith('.md')));
  const byFile = new Map();
  for (const { file, hash } of manifestEntries()) {
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(hash);
  }
  // Identity, not cardinality: each shipped agent's CURRENT bytes must be recorded, so a
  // freshly-installed copy is always recognised as installer output on the next upgrade.
  // Adding or editing an agent without regenerating the manifest reds this.
  const missing = [...shipped].filter((file) => {
    const hashes = byFile.get(file);
    return !hashes || !hashes.has(sha256(fs.readFileSync(path.join(AGENTS_SRC, file))));
  });
  assert.deepEqual(
    missing,
    [],
    `agents missing their current content hash from .known-hashes (run extension/scripts/gen-agent-known-hashes.sh): ${missing.join(', ')}`,
  );
});

test('install-agent-provenance: a superseded shipped agent version migrates to .pickle-managed', () => {
  const superseded = findSupersededShippedVersion();
  assert.ok(superseded, 'expected at least one agent whose shipped content has changed across git history');

  // Precondition that pins WHY the old guard failed: the legacy bytes differ from the
  // bytes being installed, so any current-source comparison must classify it as foreign.
  assert.notEqual(sha256(superseded.content), sha256(superseded.currentContent));
  const known = new Set(manifestEntries().filter((e) => e.file === superseded.file).map((e) => e.hash));
  assert.ok(known.has(sha256(superseded.content)), `${superseded.file}: superseded version absent from .known-hashes`);

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-provenance-migrate-'));
  try {
    const legacyPath = path.join(homeDir, '.claude', 'agents', superseded.file);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, superseded.content);

    const result = runInstall(homeDir);
    assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);

    assert.equal(
      fs.existsSync(legacyPath),
      false,
      `${superseded.file} was preserved as a user override; installer output must not shadow .pickle-managed`,
    );
    const managedPath = path.join(homeDir, '.claude', 'agents', '.pickle-managed', superseded.file);
    assert.equal(
      sha256(fs.readFileSync(managedPath)),
      sha256(superseded.currentContent),
      'managed copy must hold the version being installed',
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('install-agent-provenance: a genuine user override is preserved', () => {
  const target = fs.readdirSync(AGENTS_SRC).filter((f) => f.endsWith('.md'))[0];
  const override = `---\nname: ${target.replace(/\.md$/, '')}\ndescription: hand-authored override\ntools: [Read]\n---\n\nnever shipped by any installer version\n`;
  assert.ok(
    !manifestEntries().some((e) => e.hash === sha256(Buffer.from(override))),
    'fixture must not collide with a shipped version',
  );

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-provenance-preserve-'));
  try {
    const legacyPath = path.join(homeDir, '.claude', 'agents', target);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, override);

    const result = runInstall(homeDir);
    assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);

    assert.equal(fs.readFileSync(legacyPath, 'utf8'), override, 'user-authored override must survive install');
    assert.match(result.stdout, /Legacy agent conflict preserved/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
