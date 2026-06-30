// @tier: fast
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_UPDATE = path.resolve(__dirname, '../bin/check-update.js');
const INSTALL_SH = path.resolve(__dirname, '..', '..', 'install.sh');

/**
 * Extract the real `compare_semver` function body verbatim from install.sh
 * (no hand-copied fixture) — same brace-depth-scan approach as
 * install-script.test.js. See R-ISVP.
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

const CASES = [
  { name: 'force-only-refuses', args: ['--force'], options: { force: true }, permits: false },
  { name: 'allow-downgrade-only', args: ['--allow-downgrade'], options: { allowDowngrade: true, noConfirm: true }, permits: true },
  { name: 'force-and-allow', args: ['--force', '--allow-downgrade'], options: { force: true, allowDowngrade: true, noConfirm: true }, permits: true },
  { name: 'neither-flag', args: [], options: {}, permits: false },
];

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

function makeReleaseTarball(root, version) {
  const contentRoot = path.join(root, `release-${version}`);
  const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
  mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
  writeJson(path.join(packageRoot, 'extension', 'package.json'), { version });
  writeFileSync(
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
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
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

function readAudit(homeDir) {
  const auditPath = path.join(homeDir, '.claude', 'pickle-rick', 'deploy-audit.log');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function invocationTokenSet(invocation) {
  return new Set(invocation.trim().split(/\s+/));
}

function runCheckUpdate(root, options, releaseVersion = '1.64.0') {
  const extensionDir = path.join(root, 'extension-root');
  const dataRoot = path.join(root, 'data-root');
  const homeDir = path.join(root, 'home');
  mkdirSync(path.join(extensionDir, 'extension', 'bin'), { recursive: true });
  writeFileSync(path.join(extensionDir, 'extension', 'bin', 'log-watcher.js'), '');
  writeJson(path.join(extensionDir, 'extension', 'package.json'), { version: '1.67.0' });
  const binDir = mockGh(root, makeReleaseTarball(root, releaseVersion));
  const script = `
    import { BlockedDowngradeError, performUpgrade } from ${JSON.stringify(pathToFileURL(CHECK_UPDATE).href)};
    try {
      const result = performUpgrade('1.67.0', '1.66.0', 'v1.66.0', ${JSON.stringify(options)});
      console.log(JSON.stringify({ result }));
    } catch (error) {
      if (error instanceof BlockedDowngradeError) {
        console.log(JSON.stringify({ blocked: true, candidate: error.candidate, current: error.current }));
      } else {
        console.log(JSON.stringify({ unexpected: String(error?.message || error) }));
        process.exit(1);
      }
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXTENSION_DIR: extensionDir,
      PICKLE_DATA_ROOT: dataRoot,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    installed: existsSync(path.join(extensionDir, 'install-marker.txt')),
    audit: readAudit(homeDir),
  };
}

function makeInstallFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'force-allow-install-'));
  const homeDir = path.join(dir, 'home');
  const sourceExtension = path.join(dir, 'extension');
  const deployedExtension = path.join(homeDir, '.claude', 'pickle-rick', 'extension');
  mkdirSync(sourceExtension, { recursive: true });
  mkdirSync(deployedExtension, { recursive: true });
  writeJson(path.join(sourceExtension, 'package.json'), { version: '1.62.0' });
  writeJson(path.join(deployedExtension, 'package.json'), { version: '1.67.0' });
  const scriptPath = path.join(dir, 'install.sh');
  const header = `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${dir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
ALLOW_DOWNGRADE=0
for arg in "$@"; do
  case "$arg" in
    --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
    --force) ;;
  esac
done
read_version() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$1"
}
`;
  // Spliced in as a plain string (not a template literal) so the real
  // compare_semver's "${...}" parameter expansions are not re-interpreted
  // as JS template substitutions. No hand-copied fixture — see R-ISVP.
  const compareSemverSource = extractCompareSemverSource();
  const footer = `
SRC_V="$(read_version "$SCRIPT_DIR/extension/package.json")"
DEP_V="$(read_version "$EXTENSION_ROOT/extension/package.json")"
if ! cmp="$(compare_semver "$SRC_V" "$DEP_V")"; then
  exit 1
elif [ "$cmp" -lt 0 ]; then
  if [ "$ALLOW_DOWNGRADE" -ne 1 ]; then
    echo "REFUSE: source v$SRC_V older than deployed v$DEP_V" >&2
    exit 1
  fi
  mkdir -p "$EXTENSION_ROOT"
  AUDIT_PATH="$EXTENSION_ROOT/deploy-audit.log" SRC_V="$SRC_V" DEP_V="$DEP_V" INVOCATION="$0 $*" node -e '
    const fs = require("fs");
    fs.appendFileSync(process.env.AUDIT_PATH, JSON.stringify({
      event: "DOWNGRADE",
      src_version: process.env.SRC_V,
      dep_version: process.env.DEP_V,
      invocation: process.env.INVOCATION,
    }) + "\\n");
  '
fi
echo "mode=tarball"
`;
  writeFileSync(scriptPath, header + compareSemverSource + footer, { mode: 0o755 });
  return { dir, homeDir, scriptPath };
}

function runInstallFixture(args) {
  const fixture = makeInstallFixture();
  const result = spawnSync('bash', [fixture.scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
  return {
    fixture,
    result,
    audit: readAudit(fixture.homeDir),
  };
}

describe('force vs allow-downgrade matrix', () => {
  let roots = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  for (const matrixCase of CASES) {
    test(`${matrixCase.name}: check-update and install.sh`, () => {
      const checkRoot = mkdtempSync(path.join(tmpdir(), 'force-allow-check-update-'));
      roots.push(checkRoot);
      const checkUpdate = runCheckUpdate(checkRoot, matrixCase.options);

      const install = runInstallFixture(matrixCase.args);
      roots.push(install.fixture.dir);

      if (matrixCase.permits) {
        assert.deepEqual(checkUpdate.output.result, { success: true });
        assert.equal(checkUpdate.installed, true);
        assert.equal(checkUpdate.audit.length, 1);
        assert.equal(checkUpdate.audit[0].event, 'DOWNGRADE');
        assert.equal(checkUpdate.audit[0].src_version, '1.64.0');
        assert.equal(checkUpdate.audit[0].dep_version, '1.67.0');

        assert.equal(install.result.status, 0, install.result.stderr);
        assert.match(install.result.stdout, /mode=tarball/);
        assert.equal(install.audit.length, 1);
        assert.equal(install.audit[0].event, 'DOWNGRADE');
        assert.equal(install.audit[0].src_version, '1.62.0');
        assert.equal(install.audit[0].dep_version, '1.67.0');
        const tokens = invocationTokenSet(install.audit[0].invocation);
        for (const arg of matrixCase.args) {
          assert.equal(tokens.has(arg), true, `expected exact invocation token ${arg} in ${install.audit[0].invocation}`);
        }
      } else {
        assert.equal(checkUpdate.output.blocked, true);
        assert.equal(checkUpdate.output.candidate, '1.64.0');
        assert.equal(checkUpdate.output.current, '1.67.0');
        assert.equal(checkUpdate.installed, false);
        assert.deepEqual(checkUpdate.audit, []);

        assert.equal(install.result.status, 1);
        assert.match(install.result.stderr, /REFUSE: source v1[.]62[.]0 older than deployed v1[.]67[.]0/);
        assert.deepEqual(install.audit, []);
      }
    });
  }

  test('check-update normalizes inspected release version before downgrade decision', () => {
    const blockedRoot = mkdtempSync(path.join(tmpdir(), 'force-allow-check-update-'));
    roots.push(blockedRoot);
    const blocked = runCheckUpdate(blockedRoot, {}, 'v1.64.0');
    assert.equal(blocked.output.blocked, true);
    assert.equal(blocked.output.candidate, '1.64.0');
    assert.equal(blocked.output.current, '1.67.0');
    assert.equal(blocked.installed, false);
    assert.deepEqual(blocked.audit, []);

    const allowedRoot = mkdtempSync(path.join(tmpdir(), 'force-allow-check-update-'));
    roots.push(allowedRoot);
    const allowed = runCheckUpdate(allowedRoot, { allowDowngrade: true, noConfirm: true }, 'v1.64.0');
    assert.deepEqual(allowed.output.result, { success: true });
    assert.equal(allowed.installed, true);
    assert.equal(allowed.audit.length, 1);
    assert.equal(allowed.audit[0].src_version, '1.64.0');
    assert.equal(allowed.audit[0].dep_version, '1.67.0');
  });
});
