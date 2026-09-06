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

// The shape `.github/workflows/release.yml` ACTUALLY builds: `tar -czf ... extension/package.json
// install.sh ...` run from the repo root, with NO prefix directory, so production's payload root is
// the EMPTY string. Every other fixture in this file wraps the payload in a `pickle-rick-claude/`
// root that no release has ever emitted, which left the only path a real asset takes through this
// gate unfixtured. Asserts the archive really carries TOP-LEVEL members, so a fixture that silently
// regrows a prefix fails here instead of decaying into a duplicate of the prefixed happy path.
function makeBarePayloadTarball(version, archiveName = 'pickle-release.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-bare-'));
  const payload = path.join(dir, 'payload');
  writePackage(payload, version);
  writeFileSync(path.join(payload, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', payload, 'extension/package.json', 'install.sh']);
  const listing = run('tar', ['-tzf', tarball]).stdout;
  assert.match(listing, /^extension\/package\.json$/m, `fixture archive is not bare-rooted:\n${listing}`);
  assert.match(listing, /^install\.sh$/m, `fixture archive is not bare-rooted:\n${listing}`);
  return { dir, tarball };
}

// AP-BIN-ITER23-01. A REAL tar payload in the shape release.yml builds (bare root) carrying a
// shipped module that statically imports a sibling — the exact relationship the published asset
// broke for four months (`extension/services/state-manager.js` -> `../lib/is-record.js`). BOTH
// variants carry both sentinel members `post_tag` reads, so the only difference across the pair is
// whether the imported file rides along.
function makeRuntimePayloadTarball({ version = '1.67.0', carryImportedModule } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-runtime-'));
  const payload = path.join(dir, 'payload');
  writePackage(payload, version);
  writeFileSync(path.join(payload, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(path.join(payload, 'extension', 'services'), { recursive: true });
  writeFileSync(
    path.join(payload, 'extension', 'services', 'state-manager.js'),
    "import { isRecord } from '../lib/is-record.js';\nexport const readState = isRecord;\n",
  );
  const members = ['extension/package.json', 'install.sh', 'extension/services/state-manager.js'];
  if (carryImportedModule) {
    mkdirSync(path.join(payload, 'extension', 'lib'), { recursive: true });
    writeFileSync(
      path.join(payload, 'extension', 'lib', 'is-record.js'),
      'export const isRecord = (value) => typeof value === "object";\n',
    );
    members.push('extension/lib/is-record.js');
  }
  const tarball = path.join(dir, 'pickle-release.tar.gz');
  run('tar', ['-czf', tarball, '-C', payload, ...members]);
  const listing = run('tar', ['-tzf', tarball]).stdout;
  assert.match(listing, /^extension\/package\.json$/m, `fixture lost the package sentinel:\n${listing}`);
  assert.match(listing, /^install\.sh$/m, `fixture lost the installer sentinel:\n${listing}`);
  assert.equal(
    /^extension\/lib\/is-record\.js$/m.test(listing),
    Boolean(carryImportedModule),
    `fixture carried the wrong module set:\n${listing}`,
  );
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

// The `-xzf` arm materializes the listing as EMPTY files. That is deliberate, not a shortcut: a
// payload with no `.js` bytes has no import to resolve, so every fixture built here keeps exactly
// the verdict it had before `post_tag` learned to sweep the extracted payload. Completeness is
// exercised against a REAL tar in the AP-BIN-ITER23-01 pair below, never through this shim.
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
  -xzf)
    dest="$4"
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      case "$entry" in
        */) mkdir -p "$dest/$entry" ;;
        *) mkdir -p "$dest/$(dirname "$entry")"; : > "$dest/$entry" ;;
      esac
    done <<'MEMBERS'
${listing.join('\n')}
MEMBERS
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

  // B-RELTAG: `gh release create <tag>` with no `--target` tags the DEFAULT branch, so a tag whose
  // NAME is correct for HEAD can still point at a stale tree. Only the tagged-COMMIT arm sees that;
  // the tag-name arm is satisfied. Every other pre-tag drift fixture lets the NAME drift too, so the
  // name arm rejects first and this arm shipped unenforced — deleting it kept the suite 40/40 GREEN
  // while this exact tag reported `ok:` and exited 0. The `doesNotMatch` on the name arm's own
  // message is what keeps the pin from decaying back into a duplicate of the name-arm cases.
  test('exits 10 when the tagged commit package version drifts from HEAD even though the tag name matches', () => {
    const { dir: repoDir } = makeGitFixture({
      headVersion: '2.1.0-beta.18',
      tagVersion: '2.0.0',
      tagName: 'v2.1.0-beta.18',
    });
    try {
      const result = gate(['--pre-tag', 'v2.1.0-beta.18'], { cwd: repoDir });
      assert.equal(result.status, 10, result.stdout || result.stderr);
      assert.match(result.stderr, /but tag v2\.1\.0-beta\.18 has 2\.0\.0/);
      assert.doesNotMatch(result.stderr, /to match extension\/package\.json version/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
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

  // AP-BIN-ITER19-02. `.github/workflows/release.yml` tars `extension/package.json` and `install.sh`
  // as TOP-LEVEL members, so `list_installable_payload_roots` reaches the bare-root arms
  // (`pkg[""] = 1` / `install[""] = 1`) and `post_tag` takes the `payload_root` EMPTY branch. All 24
  // pre-existing post-tag fixtures used a `pickle-rick-claude/` prefix, so deleting either bare-root
  // arm left the suite fully GREEN while every real release asset died 21 `missing install payload
  // root`. The drift case below proves the version really comes from the bare member.
  // AP-BIN-ITER23-01. `--post-tag` is the last thing standing between a published asset and an
  // operator trusting it, and its completeness predicate was TWO members: measured `ok:` / exit 0
  // against a replay of release.yml's own tar minus `extension/lib/`, over 25 unresolved
  // specifiers. The pair below is disjoint by construction — same importer, same two sentinels,
  // same payload shape — so a gate that rejected on anything other than the missing module would
  // red the second case too.
  test('exits 21 when the release asset ships a module whose static import it does not carry', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeRuntimePayloadTarball({ carryImportedModule: false });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /ships a runtime that cannot load/);
      assert.match(result.stderr, /state-manager\.js -> \.\.\/lib\/is-record\.js/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('passes when the release asset carries every module its own payload imports', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeRuntimePayloadTarball({ carryImportedModule: true });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('passes when the release asset carries a bare payload root, the shape release.yml builds', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeBarePayloadTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when a bare-payload-root release asset carries a drifted package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeBarePayloadTarball('1.64.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /expected downloaded extension\/package\.json version 1\.67\.0 but found 1\.64\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // `normalized()` strips a leading `./` when DERIVING the payload root, but `post_tag` REBUILT the
  // member name from that stripped root and handed it to `tar -xOzf`, which matches the name as
  // STORED. GNU tar (Linux, CI) then reports "Not found in archive" and the gate dies 21
  // `could not read`, blaming a valid asset; bsdtar (macOS) normalizes the request and matches, so
  // the divergence is invisible on the only machine anyone develops on. Measured on GNU tar 1.34 vs
  // bsdtar 3.5.3. `makeFakeTarFixture` extracts by EXACT member key, so it reproduces GNU tar's
  // matching on both platforms and these cases fail identically everywhere under the old code.
  test('reads the package member by its STORED name when the archive stores a ./ prefix', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        './extension/package.json',
        './install.sh',
      ],
      {
        './extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
      assert.doesNotMatch(result.stderr, /could not read/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // DISJOINTNESS control for the ./-prefixed cases above. Every other post-tag fixture that
  // reaches extraction goes through the REAL tar, and bsdtar normalizes `./` on the command line —
  // so on macOS an implementation that prefixed `./` UNCONDITIONALLY kept the whole suite green
  // while breaking every real (non-prefixed) release asset on GNU tar. Driving the bare production
  // shape through the exact-match shim pins the other side of the wire on both platforms.
  test('reads the package member by its STORED name when the archive stores no ./ prefix', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        'extension/package.json',
        'install.sh',
      ],
      {
        'extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
      assert.doesNotMatch(result.stderr, /could not read/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // Non-vacuity control for the case above: the version must really be READ from the ./-prefixed
  // member rather than falling back to the repo package.json or to a stale reconstruction.
  test('exits 21 when a ./-prefixed release asset carries a drifted package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        './extension/package.json',
        './install.sh',
      ],
      {
        './extension/package.json': JSON.stringify({ version: '1.64.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /expected downloaded extension\/package\.json version 1\.67\.0 but found 1\.64\.0/);
      assert.doesNotMatch(result.stderr, /could not read/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // The non-empty-root arm of the same lookup: `want` is built from the root, so a ./-prefixed
  // archive WITH a payload prefix pins the `root != ""` branch the two bare cases never reach.
  test('reads the package member by its STORED name under a ./-prefixed payload root', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        './pickle-rick-claude/extension/package.json',
        './pickle-rick-claude/install.sh',
      ],
      {
        './pickle-rick-claude/extension/package.json': JSON.stringify({ version: '1.67.0' }, null, 2),
      },
    );
    const ghDir = makeGhFixture({ tarball: fakeTar.tarball });
    writeFileSync(path.join(ghDir, 'tar'), readFileSync(fakeTar.tarPath, 'utf8'), { mode: 0o755 });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
      assert.doesNotMatch(result.stderr, /could not read/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeTar.dir, { recursive: true, force: true });
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

  // AP-BIN-ITER19-03. `select_installable_tarball` carries TWO count arms: `-gt 0` (nothing
  // installable) and `-eq 1` (more than one installable). Only the first was fixtured — every
  // sidecar fixture omitted `install.sh`, so it never became installable and `-ge 1` survived the
  // suite. With the arm mutated, a release publishing two installable assets verifies
  // `installable[0]` only and ships the other one unchecked. `includeInstallScript` was written for
  // exactly this case and had no caller. `doesNotMatch` on the `-gt 0` arm's own message keeps this
  // from decaying into a duplicate of the missing-payload case.
  test('exits 21 when the release publishes two installable tar.gz assets', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0', 'pickle-release.tar.gz');
    const secondFixture = makeSidecarTarball('aaa-sidecar.tar.gz', { includeInstallScript: true });
    const ghDir = makeGhFixture({
      tarballs: [tarFixture.tarball, secondFixture.tarball],
      fakeFindNames: ['aaa-sidecar.tar.gz', 'pickle-release.tar.gz'],
    });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stderr);
      assert.match(result.stderr, /downloaded multiple installable tar\.gz assets/);
      assert.doesNotMatch(result.stderr, /missing install payload root/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(secondFixture.dir, { recursive: true, force: true });
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

  test('exits 21 when a downloaded tarball has a safe install payload plus an absolute-path archive entry', () => {
    // Regression: `listing_has_unsafe_entries` is two independent arms —
    // `entry ~ /^\//` (absolute) and `entry ~ /(^|\/)\.\.?($|\/)/` (dot-segment) — but every
    // unsafe-entry fixture was dot-segment, so deleting the absolute arm left all 27 tests GREEN.
    // The arms are DISJOINT: `/tmp/PWNED` has no `.`/`..` path segment, so the dot-segment arm
    // never sees it and the absolute arm is its ONLY rejector. GNU tar strips a leading `/` on
    // create, but nothing stops a hand-authored or non-GNU-authored header from carrying one, and
    // `tar -P`/bsdtar honor it on extract — so an absolute member escapes the install prefix
    // outright, no traversal needed. The valid payload root below is what lets the gate reach
    // exit 0 ("ok") under the mutation, proving the absolute entry was never seen.
    const { dir: repoDir, tagName } = makeGitFixture();
    const fakeTar = makeFakeTarFixture(
      [
        'pickle-rick-claude/extension/package.json',
        'pickle-rick-claude/install.sh',
        '/tmp/PWNED',
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
      assert.match(result.stderr, /unsafe archive entry \/tmp\/PWNED/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
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

// AP-BIN-ITER22-01. The release ASSET, not the gate that reads it. `bin/release-gate.sh
// --post-tag` proves only that `extension/package.json` and the installer script share a
// payload root, so it exits 0 on a payload whose runtime cannot load: measured against the
// real published v2.1.0-beta.25 asset, which carries `extension/services/state-manager.js`
// but not the `extension/lib/is-record.js` that file statically imports (11 distinct
// unresolved specifiers; `import()` of the shipped state-manager raises
// ERR_MODULE_NOT_FOUND). Cause: the workflow's tar member list ALLOW-listed 7
// subdirectories of `extension/`, so `extension/lib/` (added in e14ca028) and
// `extension/data/` were never in any asset and the omission was silent.
//
// The oracle is DERIVED, never a list: replay the workflow's OWN tar invocation over the
// real tree, then require every static relative specifier in every payload `.js` member to
// resolve to another payload member. A new runtime directory needs no edit here; dropping
// one from the workflow reddens this immediately.
function parseWorkflowTarOperands() {
  const workflow = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^\s*tar -c[a-z]*f\s/.test(line));
  assert.notEqual(start, -1, 'release.yml no longer builds the asset with `tar -c…f` — this pin cannot replay it');

  const words = [];
  for (let i = start; i < lines.length; i++) {
    const continued = lines[i].trimEnd().endsWith('\\');
    words.push(...lines[i].replace(/\\$/, '').trim().split(/\s+/));
    if (!continued) break;
  }
  // Drop `tar`, its flag word, and the output-archive operand that follows it. Shell
  // quoting is stripped wholesale, not just at the word edges: `--exclude='node_modules'`
  // quotes its VALUE, so an edge-only strip leaves a dangling quote in the pattern and
  // every exclude silently stops matching — the replay would then sweep `extension/tests/`
  // and `node_modules/` and this pin would red on fixtures instead of on the payload.
  const operands = words.slice(3).map((word) => word.replace(/['"]/g, ''));
  assert.ok(
    operands.some((word) => !word.startsWith('-')),
    `parsed no path operands from release.yml's tar invocation: ${JSON.stringify(operands)}`,
  );
  return operands;
}

function workflowPayloadMembers() {
  const listed = run('sh', [
    '-c',
    // -cf/-tf, never -czf: the member SET is the subject, and gzip is pure cost here.
    'tar -cf - "$@" | tar -tf -',
    'sh',
    ...parseWorkflowTarOperands(),
  ], { cwd: REPO_ROOT });
  assert.equal(listed.status, 0, `could not replay release.yml's tar invocation: ${listed.stderr}`);
  return new Set(
    listed.stdout.split('\n').map((name) => name.replace(/\/$/, '')).filter(Boolean),
  );
}

const RELATIVE_SPECIFIER_RE =
  /(?:from|import|require)\s*\(?\s*['"](\.\.?\/[^'"${]*\.(?:js|json))['"]/g;

function unresolvedPayloadImports(members) {
  const unresolved = [];
  for (const member of [...members].filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(path.join(REPO_ROOT, member), 'utf8');
    for (const match of source.matchAll(RELATIVE_SPECIFIER_RE)) {
      const target = path.relative(
        REPO_ROOT,
        path.resolve(path.dirname(path.join(REPO_ROOT, member)), match[1]),
      );
      if (!members.has(target)) unresolved.push(`${member} -> ${match[1]}`);
    }
  }
  return unresolved;
}

test('release-gate.the workflow asset carries every module its own runtime imports', () => {
  const members = workflowPayloadMembers();
  assert.ok(members.size > 50, `replayed payload has only ${members.size} members`);

  const jsMemberCount = [...members].filter((name) => name.endsWith('.js')).length;
  assert.ok(jsMemberCount > 50, `replayed payload has only ${jsMemberCount} .js members`);

  assert.deepEqual(
    unresolvedPayloadImports(members),
    [],
    'release.yml publishes an asset whose runtime cannot load: an import names a file the asset does not carry',
  );
});

test('release-gate.the payload sweep is disjoint from the two-sentinel post-tag check', () => {
  // Negative control. The post-tag gate greens the very payload the sweep above rejects,
  // so neither pin restates the other: amputating `extension/lib/` reds only the sweep,
  // and both members `bin/release-gate.sh` actually looks at survive untouched.
  const members = workflowPayloadMembers();
  const withoutLib = new Set([...members].filter((name) => !name.startsWith('extension/lib/')));

  assert.ok(
    members.size - withoutLib.size > 0,
    'the replayed payload carries no extension/lib/ members — the control cannot fire',
  );
  assert.ok(
    withoutLib.has('extension/package.json') && withoutLib.has('install.sh'),
    'the two members post-tag actually checks must survive the amputation, or the control proves nothing',
  );
  assert.ok(
    unresolvedPayloadImports(withoutLib).length > 0,
    'amputating extension/lib/ left every import resolvable — the sweep would not have caught the shipped defect',
  );
});
