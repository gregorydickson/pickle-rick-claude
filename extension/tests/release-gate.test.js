// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_GATE = path.join(REPO_ROOT, 'bin', 'release-gate.sh');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function writePackage(repoDir, version) {
  const extensionDir = path.join(repoDir, 'extension');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
}

function makeGitFixture({
  headVersion = '1.67.0',
  tagVersion = '1.67.0',
  tagName = `v${tagVersion}`,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-repo-'));
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['config', 'user.email', 'release-gate@example.com'], { cwd: dir });
  run('git', ['config', 'user.name', 'Release Gate'], { cwd: dir });
  writePackage(dir, tagVersion);
  run('git', ['add', 'extension/package.json'], { cwd: dir });
  run('git', ['commit', '-q', '-m', 'tag version'], { cwd: dir });
  run('git', ['tag', tagName], { cwd: dir });
  if (headVersion !== tagVersion) {
    writePackage(dir, headVersion);
    run('git', ['add', 'extension/package.json'], { cwd: dir });
    run('git', ['commit', '-q', '-m', 'head version'], { cwd: dir });
  }
  return { dir, tagName };
}

function makeTarball(version, archiveName = 'release.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-tar-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, version);
  writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'pickle-rick-claude']);
  return { dir, tarball };
}

function makeSidecarTarball(archiveName = 'sidecar.tar.gz', { includeInstallScript = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-sidecar-'));
  const root = path.join(dir, 'sidecar');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# sidecar\n');
  mkdirSync(path.join(root, 'extension'), { recursive: true });
  writeFileSync(path.join(root, 'extension', 'package.json'), `${JSON.stringify({ version: '1.67.0' }, null, 2)}\n`);
  if (includeInstallScript) {
    writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'sidecar']);
  return { dir, tarball };
}

function makeSplitPayloadTarball(archiveName = 'split.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-split-'));
  const pkgRoot = path.join(dir, 'pkg-root');
  const installRoot = path.join(dir, 'install-root');
  mkdirSync(path.join(pkgRoot, 'extension'), { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(pkgRoot, 'extension', 'package.json'), `${JSON.stringify({ version: '1.67.0' }, null, 2)}\n`);
  writeFileSync(path.join(installRoot, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'pkg-root', 'install-root']);
  return { dir, tarball };
}

function makeMultiPayloadRootTarball(archiveName = 'multi-root.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-multi-root-'));
  const firstRoot = path.join(dir, 'pickle-rick-claude');
  const secondRoot = path.join(dir, 'pickle-rick-claude-copy');
  writePackage(firstRoot, '1.67.0');
  writePackage(secondRoot, '1.67.0');
  writeFileSync(path.join(firstRoot, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(secondRoot, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'pickle-rick-claude', 'pickle-rick-claude-copy']);
  return { dir, tarball };
}

// A REAL tarball (driven through the REAL tar, no fake-tar shim) carrying a valid payload root PLUS
// one real symlink member whose target escapes the root. The member NAME is safe, so the name-only
// `tar -tzf` scan is blind to it — only the `-tvzf` link-type scan catches it.
function makeSymlinkPayloadTarball(archiveName = 'symlink.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-symlink-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, '1.67.0');
  writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  symlinkSync('../../../../../tmp/PWNED', path.join(root, 'extension', 'evil-link'));
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'pickle-rick-claude']);
  return { dir, tarball };
}

// A REAL tarball (REAL tar, no shim) carrying a valid payload root PLUS a real HARDLINK member: tar
// emits whichever of the two shared-inode paths it walks second as an `h`-type entry. The fake-tar
// shim cannot stand in here — its `-tvzf` stub hardcodes `-rw-r--r--` for every member, so no shim
// listing can ever carry a link type. Asserts the fixture really produced an `h` member so a tar
// that stopped emitting hardlink headers surfaces as a fixture failure, not a silent tautology.
function makeHardlinkPayloadTarball(archiveName = 'hardlink.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-hardlink-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, '1.67.0');
  writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const target = path.join(root, 'extension', 'linked-target.txt');
  writeFileSync(target, 'shared inode\n');
  linkSync(target, path.join(root, 'extension', 'linked-alias.txt'));
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', dir, 'pickle-rick-claude']);
  const verbose = run('tar', ['-tvzf', tarball]).stdout;
  assert.match(verbose, /^h/m, `fixture tar emitted no hardlink member:\n${verbose}`);
  return { dir, tarball };
}

// A REAL tarball (REAL tar, no shim) whose payload sentinels and one escaping symlink are the first
// members, padded past a single gzip block, then TRUNCATED mid-stream. `tar -tvzf` still LISTS the
// symlink and THEN exits non-zero on the short read — the shape that defeated the old guard: awk saw
// the link and exited 0, but `pipefail` hands the pipeline TAR's non-zero status, and the `if`-guard
// read non-zero as "no link found".
function makeTruncatedSymlinkTarball(archiveName = 'pickle-release.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-truncated-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, '1.67.0');
  writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  symlinkSync('../../../../../tmp/PWNED', path.join(root, 'extension', 'evil-link'));

  const servicesDir = path.join(root, 'extension', 'services');
  mkdirSync(servicesDir, { recursive: true });
  const members = [
    'pickle-rick-claude/extension/package.json',
    'pickle-rick-claude/install.sh',
    'pickle-rick-claude/extension/evil-link',
  ];
  for (let index = 0; index < 600; index += 1) {
    const relative = `pickle-rick-claude/extension/services/generated_module_${index}.js`;
    writeFileSync(path.join(dir, relative), `export const generatedModule${index} = ${index};\n`);
    members.push(relative);
  }

  const intact = path.join(dir, 'intact.tar.gz');
  run('tar', ['-czf', intact, '-C', dir, ...members]);
  const bytes = readFileSync(intact);
  const tarball = path.join(dir, archiveName);
  writeFileSync(tarball, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  return { dir, tarball };
}

function makeGhFixture({ mode = 'ok', tarball, tarballs, fakeFindNames, downloadAssert }) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'release-gate-bin-'));
  const ghPath = path.join(binDir, 'gh');
  const downloadTarballs = tarballs ?? (tarball ? [tarball] : ['/no/such/file']);
  const downloadAssertBlock = downloadAssert ?? '';
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -u
mode="${mode}"
if [ "$1" = "api" ]; then
  if [ "$mode" = "api-fail" ]; then exit 1; fi
  echo '{"tag_name":"v-test"}'
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  if [ "$mode" = "download-fail" ]; then exit 1; fi
  ${downloadAssertBlock}
  dest=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-D" ]; then
      shift
      dest="$1"
      break
    fi
    shift
  done
  status=0
  ${downloadTarballs.map((asset) => `cp ${JSON.stringify(asset)} "$dest/$(basename ${JSON.stringify(asset)})" || status=$?`).join('\n  ')}
  exit "$status"
fi
exit 1
`,
    { mode: 0o755 },
  );
  if (fakeFindNames) {
    writeFileSync(
      path.join(binDir, 'find'),
      `#!/usr/bin/env bash
dir="$1"
${fakeFindNames.map((name) => `printf '%s\\n' "$dir/${name}"`).join('\n')}
`,
      { mode: 0o755 },
    );
  }
  return binDir;
}

function makeFakeTarFixture(listing, extractedMembers = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-fake-tar-'));
  const tarball = path.join(dir, 'pickle-release.tar.gz');
  const tarPath = path.join(dir, 'tar');
  writeFileSync(tarball, 'fixture');
  writeFileSync(
    tarPath,
    `#!/usr/bin/env bash
set -eu
case "$1" in
  -tzf)
    cat <<'EOF'
${listing.join('\n')}
EOF
    ;;
  -tvzf)
    cat <<'EOF'
${listing.map((entry) => `-rw-r--r--  0 release gate  0 Jan  1 00:00 ${entry}`).join('\n')}
EOF
    ;;
  -xOzf)
    case "$3" in
${Object.entries(extractedMembers).map(([member, contents]) => `      ${JSON.stringify(member)}) cat <<'EOF'\n${contents}\nEOF\n        ;;`).join('\n')}
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
`,
    { mode: 0o755 },
  );
  return { dir, tarball, tarPath };
}

function gate(args, { cwd, pathPrefix } = {}) {
  return run('bash', [RELEASE_GATE, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    },
  });
}

describe('release-gate.pre-tag', () => {
  test('passes when tag package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('passes from a nested repo directory when tag package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', tagName], { cwd: path.join(repoDir, 'extension') });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 10 when tag package version is older than HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.64.0' });
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 10);
      assert.match(result.stderr, /exit 10/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 10 when tag name semver does not match HEAD package version', () => {
    const { dir: repoDir } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0', tagName: 'v9.99.0' });
    try {
      const result = gate(['--pre-tag', 'v9.99.0'], { cwd: repoDir });
      assert.equal(result.status, 10);
      assert.match(result.stderr, /match extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 11 when jq cannot parse package JSON', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    writeFileSync(path.join(repoDir, 'extension', 'package.json'), '{broken\n');
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 11);
      assert.match(result.stderr, /exit 11/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 12 when the requested tag is missing', () => {
    const { dir: repoDir } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', 'v-missing'], { cwd: repoDir });
      assert.equal(result.status, 12);
      assert.match(result.stderr, /exit 12/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('passes for a prerelease tag, the only shape this repo ships', () => {
    const { dir: repoDir, tagName } = makeGitFixture({
      headVersion: '2.1.0-beta.1',
      tagVersion: '2.1.0-beta.1',
    });
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok: tag v2\.1\.0-beta\.1 .* version 2\.1\.0-beta\.1/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 10 when a prerelease tag package version drifts from HEAD', () => {
    const { dir: repoDir, tagName } = makeGitFixture({
      headVersion: '2.1.0-beta.2',
      tagVersion: '2.1.0-beta.1',
    });
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 10);
      assert.match(result.stderr, /exit 10/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 12 when a prerelease suffix is empty', () => {
    const { dir: repoDir } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0' });
    run('git', ['tag', 'v1.67.0-'], { cwd: repoDir });
    try {
      const result = gate(['--pre-tag', 'v1.67.0-'], { cwd: repoDir });
      assert.equal(result.status, 12);
      assert.match(result.stderr, /not a semver release tag/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('release-gate.post-tag', () => {
  test('passes when downloaded tarball package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('requests release tar.gz assets via glob pattern instead of the source archive flag', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({
      tarball: tarFixture.tarball,
      downloadAssert: `
download_args=" $* "
case "$download_args" in
  *" -p *.tar.gz "*|*" --pattern *.tar.gz "*) ;;
  *) exit 98 ;;
esac
case "$download_args" in
  *" -A tar.gz "*|*" --archive tar.gz "*) exit 99 ;;
esac
`,
    });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('passes from a nested repo directory when downloaded tarball package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], {
        cwd: path.join(repoDir, 'extension'),
        pathPrefix: ghDir,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('ignores sidecar tar.gz assets and verifies the unique installable release tarball', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0', 'pickle-release.tar.gz');
    const sidecarFixture = makeSidecarTarball('aaa-sidecar.tar.gz');
    const ghDir = makeGhFixture({
      tarballs: [tarFixture.tarball, sidecarFixture.tarball],
      fakeFindNames: ['aaa-sidecar.tar.gz', 'pickle-release.tar.gz'],
    });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(sidecarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball has extension/package.json but no install.sh payload', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const sidecarFixture = makeSidecarTarball('pickle-release.tar.gz');
    const ghDir = makeGhFixture({ tarball: sidecarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /missing install payload/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(sidecarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when extension/package.json and install.sh live under different archive roots', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const splitFixture = makeSplitPayloadTarball('pickle-release.tar.gz');
    const ghDir = makeGhFixture({ tarball: splitFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /missing install payload root shared by extension\/package\.json and install\.sh/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(splitFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball contains multiple installable payload roots', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const multiRootFixture = makeMultiPayloadRootTarball('pickle-release.tar.gz');
    const ghDir = makeGhFixture({ tarball: multiRootFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /multiple install payload roots shared by extension\/package\.json and install\.sh/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(multiRootFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball uses a parent-relative install payload root', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        '../escape-root/extension/package.json',
        '../escape-root/install.sh',
      ],
      {
        '../escape-root/extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /unsafe archive entry \.\.\/escape-root\/extension\/package\.json/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball has a safe install payload plus another parent-relative archive entry', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        'pickle-rick-claude/extension/package.json',
        'pickle-rick-claude/install.sh',
        '../escape-root/payload.txt',
      ],
      {
        'pickle-rick-claude/extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /unsafe archive entry \.\.\/escape-root\/payload\.txt/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when an unsafe entry precedes a large listing that would SIGPIPE the tar producer', () => {
    // Regression: the unsafe-entry scan piped `tar -tzf | awk`, and the awk
    // exited on the first unsafe match. Under `set -o pipefail`, an early awk exit
    // SIGPIPEs the still-writing tar producer (listing > 64KB pipe buffer), so the
    // pipeline returns 141 and the `if`-guard read it as "no unsafe entry" — the
    // traversal entry slipped through. Small-listing fixtures hid this because tar
    // finished before the pipe filled. The valid payload root below makes the gate
    // exit 0 ("ok") under the bug, proving the unsafe entry was never seen.
    const { dir: repoDir, tagName } = makeGitFixture();
    const padding = Array.from(
      { length: 6000 },
      (_unused, index) => `pickle-rick-claude/extension/services/generated_module_${index}.js`,
    );
    const fakeTar = makeFakeTarFixture(
      [
        '../escape-root/payload.txt',
        'pickle-rick-claude/extension/package.json',
        'pickle-rick-claude/install.sh',
        ...padding,
      ],
      {
        'pickle-rick-claude/extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /unsafe archive entry \.\.\/escape-root\/payload\.txt/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball has a safe payload plus a symlink member whose target escapes', () => {
    // Regression: the name-only `tar -tzf` scan reads member NAMES, so a symlink whose name is
    // safe but whose target escapes the payload root (../../../../../tmp/PWNED) sailed through as
    // "no unsafe entry" — then check-update.ts extracts it and members written after the link land
    // THROUGH it, escaping the install prefix. Uses a REAL tarball through the REAL tar (no fake-tar
    // shim) so the `-tvzf` link-type scan is actually exercised.
    const { dir: repoDir, tagName } = makeGitFixture();
    const symlinkFixture = makeSymlinkPayloadTarball('pickle-release.tar.gz');
    const ghDir = makeGhFixture({ tarball: symlinkFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /symlink or hardlink member/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(symlinkFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a downloaded tarball has a safe payload plus a hardlink member', () => {
    // Regression: `listing_has_link_entries` rejects BOTH link types (`l` and `h`), but only the
    // symlink arm was ever pinned — deleting `|| type == "h"` left all 26 tests GREEN. A tar
    // hardlink header carries its target in the member's link field, which the name-only `-tzf`
    // scan never reads, so a hardlink whose NAME is safe but whose target escapes the payload root
    // is extracted as a link to the outside file and members written after it land THROUGH it.
    // The guard is a blanket rejection of every link member (the real installer payload has none),
    // and a benign real hardlink is the honest way to pin that: real tar cannot author an escaping
    // hardlink from a real filesystem, and the fake-tar shim cannot emit a link type at all.
    const { dir: repoDir, tagName } = makeGitFixture();
    const hardlinkFixture = makeHardlinkPayloadTarball('pickle-release.tar.gz');
    const ghDir = makeGhFixture({ tarball: hardlinkFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /symlink or hardlink member/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(hardlinkFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a truncated tarball hides an escaping symlink behind a tar read error', () => {
    // Regression: the link and name scans were `tar ... | awk` pipelines consumed as `if`-guards.
    // Under `set -o pipefail` a pipeline yields TAR's status whenever tar fails, and that status
    // MASKS awk's verdict — awk exits 0 on a detected link, tar's non-zero wins, and the guard reads
    // it as "clean". A truncated archive still LISTS its escaping symlink, so the gate sailed past
    // the very link awk had just printed. Every listing is now materialized and status-checked
    // BEFORE it is scanned: an archive tar cannot fully list is unverifiable, so it dies rather than
    // ships. The valid payload root in the fixture is what let the buggy gate reach "ok".
    const { dir: repoDir, tagName } = makeGitFixture();
    const truncated = makeTruncatedSymlinkTarball();
    const ghDir = makeGhFixture({ tarball: truncated.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /could not list archive entries/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(truncated.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 20 when release asset download fails', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const ghDir = makeGhFixture({ mode: 'download-fail' });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 20);
      assert.match(result.stderr, /exit 20/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when downloaded tarball package version is older than HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0' });
    const tarFixture = makeTarball('1.64.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /exit 21/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when the tagged commit package version drifts from HEAD even if the tarball matches HEAD', () => {
    const { dir: repoDir } = makeGitFixture({
      headVersion: '1.67.0',
      tagVersion: '1.64.0',
      tagName: 'v1.67.0',
    });
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', 'v1.67.0'], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /tag v1\.67\.0 has 1\.64\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when tag name semver does not match HEAD package version', () => {
    const { dir: repoDir } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0', tagName: 'v9.99.0' });
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', 'v9.99.0'], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /match extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 22 when the GitHub release API check fails', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const ghDir = makeGhFixture({ mode: 'api-fail' });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 22);
      assert.match(result.stderr, /exit 22/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });
});
