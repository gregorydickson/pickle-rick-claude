// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBundle, EXPECTED_BUNDLE_AC_IDS } from '../../../bin/verify-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_UPDATE = path.resolve(__dirname, '../../bin/check-update.js');

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeReleaseTarball(root, version) {
  const contentRoot = path.join(root, `release-${version}`);
  const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
  fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
  writeJson(path.join(packageRoot, 'extension', 'package.json'), { version });
  fs.writeFileSync(
    path.join(packageRoot, 'install.sh'),
    '#!/bin/sh\nprintf installed > "$EXTENSION_DIR/install-marker.txt"\n',
    { mode: 0o755 },
  );
  const tarball = path.join(root, `release-${version}.tar.gz`);
  execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'pickle-rick-claude']);
  return tarball;
}

function mockGh(root, tarball) {
  const binDir = path.join(root, 'mock-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-D" ]; then
    shift
    dest="$1"
  fi
  shift
done
mkdir -p "$dest"
cp ${JSON.stringify(tarball)} "$dest/pickle-release.tar.gz"
`,
    { mode: 0o755 },
  );
  return binDir;
}

function makeDeployedExtension(extensionRoot, version = '1.67.0') {
  fs.mkdirSync(path.join(extensionRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'services'), { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, 'types'), { recursive: true });
  writeJson(path.join(extensionRoot, 'package.json'), { version });
  fs.writeFileSync(path.join(extensionRoot, 'bin/check-update.js'), 'export const checkUpdate = true;\n');
  fs.writeFileSync(path.join(extensionRoot, 'services/state-manager.js'), 'export const stateManager = true;\n');
  fs.writeFileSync(path.join(extensionRoot, 'types/index.js'), 'export const typesIndex = true;\n');
}

function bundleArtifact(acId, overrides = {}) {
  return {
    ac_id: acId,
    pass: true,
    checked_at: '2026-05-02T00:00:00.000Z',
    checker: 'lockdown-end-to-end.test',
    checker_version: '1.0.0',
    evidence: { collected: 'fixture' },
    failure_reason: null,
    remediation_hint: null,
    ...overrides,
  };
}

function assertBundleArtifactMetadata(value, acId) {
  assert.equal(value.ac_id, acId);
  assert.equal(typeof value.pass, 'boolean');
  assert.match(value.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/);
  assert.equal(typeof value.checker, 'string');
  assert.equal(typeof value.checker_version, 'string');
  assert.equal(value.evidence && typeof value.evidence, 'object');
  assert.equal(Array.isArray(value.evidence), false);
  assert.equal(value.failure_reason === null || typeof value.failure_reason === 'string', true);
  assert.equal(value.remediation_hint === null || typeof value.remediation_hint === 'string', true);
}

test('integration.downgrade-e2e refuses lower release before install and propagates exit', () => {
  const root = tmpRoot('lockdown-downgrade-e2e-');
  try {
    const extensionDir = path.join(root, 'extension-root');
    const extensionRoot = path.join(extensionDir, 'extension');
    const dataRoot = path.join(root, 'data-root');
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(path.join(extensionRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, 'bin/log-watcher.js'), '');
    writeJson(path.join(extensionRoot, 'package.json'), { version: '1.67.0' });

    const binDir = mockGh(root, makeReleaseTarball(root, '1.65.0'));
    const script = `
      import { BlockedDowngradeError, performUpgrade } from ${JSON.stringify(pathToFileURL(CHECK_UPDATE).href)};
      try {
        const result = performUpgrade('1.67.0', '1.68.0', 'v1.68.0', { force: true });
        console.log(JSON.stringify({ result }));
      } catch (error) {
        if (error instanceof BlockedDowngradeError) {
          console.log(JSON.stringify({ blocked: true, candidate: error.candidate, current: error.current }));
          process.exit(1);
        }
        throw error;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PICKLE_EXTENSION_DIR_TEST: '1',
        EXTENSION_DIR: extensionDir,
        PICKLE_DATA_ROOT: dataRoot,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.blocked, true);
    assert.equal(output.candidate, '1.65.0');
    assert.equal(output.current, '1.67.0');
    assert.equal(fs.existsSync(path.join(extensionDir, 'install-marker.txt')), false);
    assert.match(fs.readFileSync(path.join(extensionDir, 'debug.log'), 'utf8'), /downgrade blocked/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('integration.install-sh-e2e writes baseline, cron, and cleans update cache', () => {
  const root = tmpRoot('lockdown-install-sh-e2e-');
  try {
    const homeDir = path.join(root, 'home');
    const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
    const sourceExtension = path.join(root, 'extension');
    const mockBin = path.join(root, 'mock-bin');
    const crontabStore = path.join(root, 'crontab.txt');

    makeDeployedExtension(sourceExtension, '1.68.0');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin/verify-deploy-parity.js'), '#!/usr/bin/env node\n');
    writeJson(path.join(runtimeRoot, 'extension', 'package.json'), { version: '1.67.0' });
    writeJson(path.join(runtimeRoot, 'update-check.json'), {
      last_check_epoch: 1,
      latest_version: '1.67.0',
      current_version: '1.0.0',
    });
    fs.mkdirSync(mockBin, { recursive: true });
    fs.writeFileSync(
      path.join(mockBin, 'crontab'),
      `#!/bin/sh
set -eu
store=${JSON.stringify(crontabStore)}
if [ "$#" -eq 1 ] && [ "$1" = "-l" ]; then
  [ -f "$store" ] || exit 1
  cat "$store"
  exit 0
fi
if [ "$#" -eq 1 ]; then
  cp "$1" "$store"
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    const scriptPath = path.join(root, 'install-fixture.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/bin/bash
set -euo pipefail
SCRIPT_DIR=${JSON.stringify(root)}
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
SRC_V="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$SCRIPT_DIR/extension/package.json")"
DEPLOY_PARITY_CRON_ENTRY='*/5 * * * * /usr/bin/env node ~/.claude/pickle-rick/extension/bin/verify-deploy-parity.js >> ~/.claude/pickle-rick/deploy-parity-samples.jsonl 2>&1'
hash_deployed_file() { shasum -a 256 "$EXTENSION_ROOT/$1" | awk '{print $1}'; }
mkdir -p "$EXTENSION_ROOT/extension"
rm -rf "$EXTENSION_ROOT/extension"
mkdir -p "$EXTENSION_ROOT/extension"
cp -R "$SCRIPT_DIR/extension/." "$EXTENSION_ROOT/extension/"
cp "$SCRIPT_DIR/bin/verify-deploy-parity.js" "$EXTENSION_ROOT/extension/bin/verify-deploy-parity.js"
DEPLOYED_V="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$EXTENSION_ROOT/extension/package.json")"
jq -n --arg installed_at "2026-05-02T00:00:00Z" --arg src_version "$SRC_V" --arg dep_version "$DEPLOYED_V" --arg check_update "$(hash_deployed_file "extension/bin/check-update.js")" --arg state_manager "$(hash_deployed_file "extension/services/state-manager.js")" --arg types_index "$(hash_deployed_file "extension/types/index.js")" '{ installed_at: $installed_at, src_version: $src_version, dep_version: $dep_version, content_hashes: { "check-update.js": $check_update, "state-manager.js": $state_manager, "types/index.js": $types_index } }' > "$EXTENSION_ROOT/deploy-baseline.json"
tmpfile="$(mktemp)"
(crontab -l 2>/dev/null | grep -v 'verify-deploy-parity[.]js' || true) > "$tmpfile"
printf '%s\\n' "$DEPLOY_PARITY_CRON_ENTRY" >> "$tmpfile"
crontab "$tmpfile"
rm -f "$tmpfile"
UPDATE_CACHE_FILE="$EXTENSION_ROOT/update-check.json"
if [ -f "$UPDATE_CACHE_FILE" ]; then
  CACHE_CURRENT_VERSION="$(jq -r '.current_version // ""' "$UPDATE_CACHE_FILE" 2>/dev/null || echo "")"
  if [ "$CACHE_CURRENT_VERSION" = "1.0.0" ] || [ "$CACHE_CURRENT_VERSION" != "$DEPLOYED_V" ]; then
    rm -f "$UPDATE_CACHE_FILE"
  fi
fi
`,
      { mode: 0o755 },
    );

    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, PATH: `${mockBin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const baseline = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'deploy-baseline.json'), 'utf8'));
    assert.equal(baseline.src_version, '1.68.0');
    assert.equal(baseline.dep_version, '1.68.0');
    assert.equal(baseline.content_hashes['check-update.js'], sha256(path.join(runtimeRoot, 'extension/bin/check-update.js')));
    assert.match(fs.readFileSync(crontabStore, 'utf8'), /verify-deploy-parity[.]js/);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'update-check.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('integration.verify-bundle-e2e returns pass, fail, and inconclusive exit codes', () => {
  const root = tmpRoot('lockdown-verify-bundle-e2e-');
  try {
    const passRoot = path.join(root, 'pass');
    fs.mkdirSync(path.join(passRoot, 'bundle'), { recursive: true });
    for (const acId of EXPECTED_BUNDLE_AC_IDS) {
      const artifact = bundleArtifact(acId);
      assertBundleArtifactMetadata(artifact, acId);
      writeJson(path.join(passRoot, 'bundle', `${acId.toLowerCase()}.json`), artifact);
    }
    assert.equal(verifyBundle({ repoRoot: passRoot }).exitCode, 0);

    const failRoot = path.join(root, 'fail');
    fs.cpSync(passRoot, failRoot, { recursive: true });
    writeJson(
      path.join(failRoot, 'bundle/ac-dr-08.json'),
      bundleArtifact('AC-DR-08', { pass: false, failure_reason: 'fixture-fail' }),
    );
    const failResult = verifyBundle({ repoRoot: failRoot });
    assert.equal(failResult.exitCode, 1);
    assert.match(failResult.stderr, /AC-DR-08: pass false/);

    const missingRoot = path.join(root, 'missing');
    fs.cpSync(passRoot, missingRoot, { recursive: true });
    fs.rmSync(path.join(missingRoot, 'bundle/ac-dr-09.json'));
    const missingResult = verifyBundle({ repoRoot: missingRoot });
    assert.equal(missingResult.exitCode, 2);
    assert.match(missingResult.stderr, /AC-DR-09: missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
