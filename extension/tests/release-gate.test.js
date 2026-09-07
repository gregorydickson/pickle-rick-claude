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
import zlib from 'node:zlib';

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

// AP-BIN-ITER24-01. The runtime module is not decoration: `post_tag` now refuses a payload it
// could not measure, and every fixture here that expects exit 0 must therefore be a payload a real
// installer could deploy. One self-resolving module is the minimum that makes the completeness
// sweep say something rather than nothing.
function makeTarball(version, archiveName = 'release.tar.gz') {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-tar-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, version);
  writeFileSync(path.join(root, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(path.join(root, 'extension', 'services'), { recursive: true });
  writeFileSync(
    path.join(root, 'extension', 'services', 'state-manager.js'),
    'export const readState = () => null;\n',
  );
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
// AP-BIN-ITER24-01. `carryRuntimeModule` defaults TRUE because the two sentinels alone are not a
// shippable payload: an asset with no `.js` member at all cannot load, and the completeness sweep
// is silent over it (it finds no unresolved specifier because it resolves nothing). The false
// variant is that asset, and it is the ONLY difference across the pair — same bare root, same two
// sentinels, same version — so a gate rejecting on anything else reds the true variant too.
function makeBarePayloadTarball(version, archiveName = 'pickle-release.tar.gz', {
  carryRuntimeModule = true,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-bare-'));
  const payload = path.join(dir, 'payload');
  writePackage(payload, version);
  writeFileSync(path.join(payload, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const members = ['extension/package.json', 'install.sh'];
  if (carryRuntimeModule) {
    mkdirSync(path.join(payload, 'extension', 'services'), { recursive: true });
    writeFileSync(
      path.join(payload, 'extension', 'services', 'state-manager.js'),
      'export const readState = () => null;\n',
    );
    members.push('extension/services/state-manager.js');
  }
  const tarball = path.join(dir, archiveName);
  run('tar', ['-czf', tarball, '-C', payload, ...members]);
  const listing = run('tar', ['-tzf', tarball]).stdout;
  assert.match(listing, /^extension\/package\.json$/m, `fixture archive is not bare-rooted:\n${listing}`);
  assert.match(listing, /^install\.sh$/m, `fixture archive is not bare-rooted:\n${listing}`);
  assert.equal(
    /^extension\/services\/state-manager\.js$/m.test(listing),
    carryRuntimeModule,
    `fixture carried the wrong module set:\n${listing}`,
  );
  return { dir, tarball };
}

// AP-BIN-ITER23-01. A REAL tar payload in the shape release.yml builds (bare root) carrying a
// shipped module that statically imports a sibling — the exact relationship the published asset
// broke for four months (`extension/services/state-manager.js` -> `../lib/is-record.js`). BOTH
// variants carry both sentinel members `post_tag` reads, so the only difference across the pair is
// whether the imported file rides along.
// AP-BIN-ITER25-01. `tar` must READ a file to archive it, so no tar invocation can publish a
// member stored mode 000, and bsdtar has no `--mode` at all — the only portable way to build the
// asset this arm exists to reject is to rewrite that one member's ustar mode field in an archive
// REAL tar produced. Everything else about the asset stays tar's own output: members, order,
// contents, both sentinels. The ustar checksum is recomputed with the checksum field read as
// spaces, exactly as the format specifies, or every tar refuses the archive outright.
function storeMemberMode(tarballPath, memberName, mode) {
  const raw = zlib.gunzipSync(readFileSync(tarballPath));
  let patched = 0;
  for (let offset = 0; offset + 512 <= raw.length; offset += 512) {
    const name = raw.toString('utf8', offset, offset + 100).replace(/\0[\s\S]*$/, '');
    if (name !== memberName) continue;
    raw.write(`${mode.toString(8).padStart(7, '0')}\0`, offset + 100, 8, 'ascii');
    raw.fill(0x20, offset + 148, offset + 156);
    let sum = 0;
    for (let i = offset; i < offset + 512; i += 1) sum += raw[i];
    raw.write(`${sum.toString(8).padStart(6, '0')}\0 `, offset + 148, 8, 'ascii');
    patched += 1;
  }
  assert.equal(patched, 1, `expected exactly one ustar header named ${memberName}, patched ${patched}`);
  writeFileSync(tarballPath, zlib.gzipSync(raw));
}

// Every pair keyed on a stored mode differs ONLY in that mode, so each fixture asserts the mode
// back out of `-tvzf` rather than trusting the rewrite — a decayed rewrite would silently turn
// such a test into a duplicate of its own control. Derived from the requested mode, so widening
// the domain past 000 needs no edit here.
function storedPermissions(mode) {
  return 'rwxrwxrwx'
    .split('')
    .map((bit, index) => (((mode >> (8 - index)) & 1) ? bit : '-'))
    .join('');
}

// AP-BIN-ITER26-01. The members below are the DIRECTORIES, not the files inside them, because
// `.github/workflows/release.yml` tars `extension/` whole — so every real asset carries directory
// headers with their own stored modes, and a fixture naming files alone leaves that member class,
// and every gate behaviour keyed on it, unfixtured. `dirMode` is `moduleMode`'s sibling: the same
// ustar rewrite, applied to the `extension/services/` header.
function makeRuntimePayloadTarball({ version = '1.67.0', carryImportedModule, moduleMode, dirMode } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-runtime-'));
  const payload = path.join(dir, 'payload');
  writePackage(payload, version);
  writeFileSync(path.join(payload, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(path.join(payload, 'extension', 'services'), { recursive: true });
  writeFileSync(
    path.join(payload, 'extension', 'services', 'state-manager.js'),
    "import { isRecord } from '../lib/is-record.js';\nexport const readState = isRecord;\n",
  );
  const members = ['extension/package.json', 'install.sh', 'extension/services'];
  if (carryImportedModule) {
    mkdirSync(path.join(payload, 'extension', 'lib'), { recursive: true });
    writeFileSync(
      path.join(payload, 'extension', 'lib', 'is-record.js'),
      'export const isRecord = (value) => typeof value === "object";\n',
    );
    members.push('extension/lib');
  }
  const tarball = path.join(dir, 'pickle-release.tar.gz');
  run('tar', ['-czf', tarball, '-C', payload, ...members]);
  if (moduleMode !== undefined) storeMemberMode(tarball, 'extension/services/state-manager.js', moduleMode);
  if (dirMode !== undefined) storeMemberMode(tarball, 'extension/services/', dirMode);
  const listing = run('tar', ['-tzf', tarball]).stdout;
  assert.match(listing, /^extension\/package\.json$/m, `fixture lost the package sentinel:\n${listing}`);
  assert.match(listing, /^install\.sh$/m, `fixture lost the installer sentinel:\n${listing}`);
  assert.equal(
    /^extension\/lib\/is-record\.js$/m.test(listing),
    Boolean(carryImportedModule),
    `fixture carried the wrong module set:\n${listing}`,
  );
  const verbose = run('tar', ['-tvzf', tarball]).stdout;
  const importerRow = verbose.split('\n').find((row) => row.endsWith('extension/services/state-manager.js'));
  assert.equal(
    /^-{10}\s/.test(importerRow ?? ''),
    moduleMode === 0o000,
    `fixture stored the wrong mode for the importer:\n${verbose}`,
  );
  const dirRow = verbose.split('\n').find((row) => row.endsWith('extension/services/'));
  assert.match(
    dirRow ?? '',
    dirMode === undefined ? /^drwx/ : new RegExp(`^d${storedPermissions(dirMode)}\\s`),
    `fixture stored the wrong mode for the importer's directory:\n${verbose}`,
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
  // The gate calls `find` TWICE with different jobs: once to discover the downloaded `*.tar.gz`
  // assets (this stub exists to pin their order) and once to sweep the EXTRACTED payload for
  // `*.js` modules. A stub answering both hands the completeness sweep two paths that do not
  // exist, so it measures nothing — which `payload_relative_specifiers`' trailing `|| true` then
  // reported as clean (AP-BIN-ITER25-01). Delegate every other call to the real `find`.
  if (fakeFindNames) {
    writeFileSync(
      path.join(binDir, 'find'),
      `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = '*.js' ]; then
    for real in /usr/bin/find /bin/find; do
      if [ -x "$real" ]; then exec "$real" "$@"; fi
    done
    echo "find stub: no real find on this host" >&2
    exit 127
  fi
done
dir="$1"
${fakeFindNames.map((name) => `printf '%s\\n' "$dir/${name}"`).join('\n')}
`,
      { mode: 0o755 },
    );
  }
  return binDir;
}

// The `-xzf` arm materializes the listing as EMPTY files. That is deliberate, not a shortcut: an
// empty `.js` has no import to resolve, so a fixture built here is CLEAN to the completeness sweep
// as long as its listing carries at least one `.js` member — and since AP-BIN-ITER24-01 the sweep
// distinguishes clean from unmeasured, so a listing with no module at all now dies 21 instead of
// greening. Green fixtures here must therefore name a runtime module; the omission fails loudly
// with `carries no runtime modules to verify`. Completeness itself is exercised against a REAL tar
// in the AP-BIN-ITER23-01 pair below, never through this shim.
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

// AP-BIN-ITER27-01. A payload carrying a directory `rm -rf` cannot remove leaves the gate's own
// `mktemp -d` behind, and a caller CANNOT place that root: macOS `mktemp -d` resolves the Darwin
// per-user temp directory through confstr and ignores `$TMPDIR` outright (measured), so the
// `TMPDIR`-passing option this replaces removed an empty directory of its own, reported success,
// and leaked the real root once per run. Recover the path from cleanup's own stderr instead — `rm`
// names every directory it refused, innermost first, so the LAST is the gate's root. BSD prints
// `rm: <path>: ...` and GNU `rm: cannot remove '<path>': ...`.
//
// WHICH path each names is NOT portable and must not be assumed: BSD `rm` reports the DIRECTORY it
// could not clear and then every ancestor, so its last line is the root, while GNU `rm` descends
// into a mode-500 directory it can still read and reports the FILE whose unlink was refused --
// measured on Ubuntu 24.04, where taking the last line handed back a file path and the reclaim
// below then failed EACCES. Anchor on the gate's own structure instead: `post_tag` extracts into
// `$tmpdir/payload`, so the segment before `/payload` is the root under either `rm`.
//
// Only `rm:` lines count. A `find:` refusal proves the payload was unwalkable, not that cleanup
// failed, and cleanup failing is exactly what the two cases calling this must establish: a
// removable temp root never runs `rm` to failure, so their exit-code assertions would hold with
// the status-preserving cleanup amputated. Returning null is a test failure at the call site.
function undeletableGateTmpdir(stderr) {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('rm:')) continue;
    const match = /(\/[^\s'"]*)\/payload(?:[/'"]|$)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function reclaimUndeletableGateTmpdir(leaked) {
  if (leaked === null) return;
  // Assert the restore, or a future portability break surfaces as an EACCES stack from `rmSync`
  // in an unrelated frame instead of naming the step that actually failed.
  const restored = run('chmod', ['-R', 'u+rwX', leaked]);
  assert.equal(restored.status, 0, `could not restore modes under ${leaked}: ${restored.stderr}`);
  rmSync(leaked, { recursive: true, force: true });
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

  // AP-BIN-ITER25-01. The sweep AP-BIN-ITER23-01 built resolves specifiers `grep` reports, and
  // `payload_relative_specifiers` ended `|| true` — which swallows grep's exit 2 (READ error)
  // alongside its exit 1 (measured, no match). A member the extractor writes mode 000 therefore
  // scored as a module holding no imports and the gate printed `ok:` over a runtime it never read:
  // the same nothing-measured-is-not-a-verdict false-green AP-BIN-ITER24-01 closed for the empty
  // module set, one level down. Measured on the shipped functions before the fix: the identical
  // module yields status 1 (clean) at mode 000 and status 0 (RED) at 0644.
  //
  // Disjoint by construction from the GREEN control above: same fixture, same members, same
  // contents, same imports, same two sentinels — the ONLY difference is the stored mode of
  // `extension/services/state-manager.js`, so a gate rejecting on anything else reds the control.
  test('exits 21 when the release asset ships a module the gate cannot read', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeRuntimePayloadTarball({ carryImportedModule: true, moduleMode: 0o000 });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /ships extension\/services\/state-manager\.js but the gate could not read it/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // AP-BIN-ITER26-01. The sweep enumerated its modules through a process substitution, whose exit
  // status is unreachable. `find` prints everything it DID reach before exiting non-zero for a
  // directory it could not walk, so a PARTIAL enumeration arrived as a NON-EMPTY file set: the
  // AP-BIN-ITER24-01 empty-set guard could not see it, `payload_unresolved_import` resolved the
  // modules it happened to reach and returned 1 — the MEASURED-clean verdict — over the ones it
  // never opened, and `post_tag` printed `ok:`. That is the third producer of the same
  // nothing-measured-is-not-a-verdict false-green: AP-BIN-ITER24-01 closed the empty module set and
  // AP-BIN-ITER25-01 the unreadable FILE, while the unwalkable DIRECTORY defeated both. Measured on
  // the shipped gate before the fix, on macOS AND on Ubuntu 24.04 under docker: `ok: release
  // v1.67.0 tarball has extension/package.json version 1.67.0` for this asset, against `die 21` for
  // the identical asset with the directory walkable.
  //
  // Disjoint by construction from the GREEN control above: same fixture, same members, same
  // contents, same imports, same two sentinels, and here the import RESOLVES — the ONLY difference
  // is the stored mode of the `extension/services/` DIRECTORY member, so a gate rejecting on
  // anything else reds the control too.
  test('exits 21 when the release asset holds a directory the gate cannot walk', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeRuntimePayloadTarball({ carryImportedModule: true, dirMode: 0o000 });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    let leaked = null;
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      leaked = undeletableGateTmpdir(result.stderr);
      // AP-BIN-ITER27-01. The status is a discriminator again: the same undeletable directory that
      // defeats `find` also defeats the EXIT trap's `rm -rf`, and under `set -e` that failure used
      // to exit the shell FROM INSIDE the trap carrying `rm`'s status — so this asset reported an
      // undocumented 1 for `die 21`, and reported 1 for the pre-fix `ok:` run as well. Pinning 21
      // exactly is what keeps the trap from silently re-acquiring the script's exit code.
      assert.equal(result.status, 21, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /carries no runtime modules to verify/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
      // Without this the case is vacuous: a temp root the trap CAN remove never runs `rm` to
      // failure, and the exit-code assertion above would hold with the fix amputated.
      assert.notEqual(leaked, null, `cleanup must actually fail here:\n${result.stderr}`);
    } finally {
      reclaimUndeletableGateTmpdir(leaked);
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  // AP-BIN-ITER27-01, the disjoint half. The pair above and this one differ ONLY in the stored mode
  // of the `extension/services/` directory member: 000 blocks `find` and produces `die 21`, 500
  // admits `find` and the import RESOLVES, so the gate reaches `ok:` and exit 0. Both modes defeat
  // `rm -rf` identically (removing a child needs WRITE on its directory, which neither grants), so
  // pre-fix BOTH halves collapsed onto the cleanup's exit 1 — the green run reporting failure and
  // the red run losing its documented code. This half is the only case in the suite where cleanup
  // fails on a run the gate PASSES, so it is the sole pin on the exit-0 direction.
  test('reports the gate\'s own exit 0, not the cleanup\'s status, when its tmpdir cannot be removed', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeRuntimePayloadTarball({ carryImportedModule: true, dirMode: 0o500 });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    let leaked = null;
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      leaked = undeletableGateTmpdir(result.stderr);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /ok: release .* tarball has extension\/package\.json version 1\.67\.0/);
      // Two independent ways this case could pass for the wrong reason, both closed here: the EXIT
      // trap must have actually FAILED (a removable temp root never runs `rm` to failure, so exit 0
      // would hold with the fix amputated), and the sweep must have actually MEASURED the importer
      // inside the 500 directory rather than skipping one it never extracted.
      assert.notEqual(leaked, null, `cleanup must actually fail here:\n${result.stderr}`);
      const survivor = run('find', [leaked]).stdout;
      assert.match(survivor, /payload\/extension\/services\/state-manager\.js$/m, survivor);
    } finally {
      reclaimUndeletableGateTmpdir(leaked);
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

  // AP-BIN-ITER24-01. AP-BIN-ITER23-01 replaced the two-sentinel completeness check with a sweep
  // derived from the payload's own imports — but a sweep over ZERO modules reports no unresolved
  // specifier, so the most extreme incomplete asset (both sentinels, no runtime at all) still
  // printed `ok:`. Measured on the shipped gate before the fix: exit 0. `payload_unresolved_import`
  // now separates "measured, clean" (1) from "nothing measured" (2) and post_tag dies on the
  // latter, so the sweep can never green what it never read.
  test('exits 21 when the release asset carries both sentinels but no runtime module at all', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeBarePayloadTarball('1.67.0', 'pickle-release.tar.gz', {
      carryRuntimeModule: false,
    });
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21, result.stdout || result.stderr);
      assert.match(result.stderr, /carries no runtime modules to verify/);
      assert.doesNotMatch(result.stdout, /^ok:/m);
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
        './extension/services/state-manager.js',
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
        'extension/services/state-manager.js',
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
        './pickle-rick-claude/extension/services/state-manager.js',
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

// AP-BIN-ITER28-01. `extension/` minus install.sh's rsync excludes is NOT the deployable set:
// install.sh also copies `extension/src/types/activity-events.schema.json` over the `$ref` stub
// that ships at `extension/activity-events.schema.json`, and `--exclude='src'` prunes that source
// from the asset. MEASURED end to end on the real compiled runtime: a git-mode deploy carries the
// 80164-byte schema and `bin/log-activity.js` rejects an emission missing a schema-required field
// (rc 1, names the field); the same runtime deployed from a replayed asset carries the 112-byte
// stub, `definitions` reads as `{}`, and the identical invalid emission is ACCEPTED at rc 0 with
// no diagnostic — the "no candidate path resolved" arm cannot fire, because the stub RESOLVES.
// An auto-update regresses a healthy deploy that way: `check-update.ts` runs install.sh from the
// extract dir (tarball mode), the rsync overwrites the real bytes with the stub, and the `cp`
// that would repair it is guarded by `[ -f "$_schema_src" ]` on a path the payload does not carry.
//
// Pin the OUTCOME, not the path: replay the workflow's OWN build block over a fixture and require
// the member `bin/log-activity.js` actually loads to parse with a non-empty `definitions`. A
// staging step that moves, or a schema that relocates, keeps this green as long as validation
// survives the trip; deleting the staging reds it.
function parseWorkflowBuildBlock() {
  const workflow = readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => /^\s*- name: Build tarball\s*$/.test(line));
  assert.notEqual(start, -1, 'release.yml no longer has a `Build tarball` step — this pin cannot replay it');
  const runAt = lines.findIndex((line, index) => index > start && /^\s*run: \|\s*$/.test(line));
  assert.notEqual(runAt, -1, 'the `Build tarball` step no longer carries a `run: |` block');

  const indent = lines[runAt + 1].match(/^\s*/)[0];
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].startsWith(indent)) break;
    body.push(lines[i].slice(indent.length));
  }
  const script = body.join('\n');
  assert.match(script, /tar -c[a-z]*f\s/, `parsed no tar invocation from the Build tarball block: ${script}`);
  return script;
}

// The tar operands the workflow names, minus the archive it writes — the paths a replay fixture
// must materialize. Derived so a new operand cannot leave the fixture silently short.
function workflowFixturePaths() {
  return parseWorkflowTarOperands()
    .filter((operand) => !operand.startsWith('-'))
    .map((operand) => operand.replace(/\/$/, ''));
}

// The path `bin/log-activity.js` actually opens in a deployed tree: its first candidate lives
// under `src/`, which no deploy carries, so the second is the one every install resolves.
const DEPLOYED_SCHEMA_MEMBER = 'extension/activity-events.schema.json';

function replayWorkflowBuild() {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-build-'));
  const stub = { $schema: 'http://json-schema.org/draft-07/schema#', $ref: './src/types/activity-events.schema.json' };
  const real = { definitions: { baseline_attempt_timeout: { required: ['session'] } } };

  mkdirSync(path.join(dir, 'extension', 'src', 'types'), { recursive: true });
  writeFileSync(path.join(dir, DEPLOYED_SCHEMA_MEMBER.replace('extension/', 'extension/')), `${JSON.stringify(stub)}\n`);
  writeFileSync(path.join(dir, 'extension', 'src', 'types', 'activity-events.schema.json'), `${JSON.stringify(real)}\n`);
  // Without this the pin is vacuous: it must be possible for the staged member to still be the
  // stub, or "carries definitions" proves nothing about the staging step.
  assert.equal(
    JSON.parse(readFileSync(path.join(dir, DEPLOYED_SCHEMA_MEMBER), 'utf8')).definitions,
    undefined,
    'the fixture stub already carries definitions — this replay could not observe a missing staging step',
  );

  for (const operand of workflowFixturePaths()) {
    const target = path.join(dir, operand);
    if (/\.[a-z]+$/.test(operand)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'fixture\n');
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'fixture.md'), 'fixture\n');
    }
  }

  const built = run('bash', ['-e', '-c', parseWorkflowBuildBlock()], {
    cwd: dir,
    env: {
      ...process.env,
      GITHUB_REF_NAME: 'v9.9.9',
      GITHUB_ENV: path.join(dir, 'github_env'),
    },
  });
  assert.equal(built.status, 0, `could not replay release.yml's Build tarball block: ${built.stderr}`);
  return { dir, tarball: path.join(dir, 'pickle-rick-9.9.9.tar.gz') };
}

test('release-gate.the workflow asset carries a schema the deployed runtime can validate against', () => {
  const { dir, tarball } = replayWorkflowBuild();
  try {
    const shipped = run('tar', ['-xOzf', tarball, DEPLOYED_SCHEMA_MEMBER]);
    assert.equal(shipped.status, 0, `the asset does not carry ${DEPLOYED_SCHEMA_MEMBER}: ${shipped.stderr}`);

    const parsed = JSON.parse(shipped.stdout);
    assert.ok(
      parsed.definitions && Object.keys(parsed.definitions).length > 0,
      `release.yml publishes an asset whose ${DEPLOYED_SCHEMA_MEMBER} carries no definitions, so every`
        + ` deployed schema-required-field check is skipped: ${shipped.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// AP-BIN-ITER29-01. The same silent-omission class one level out from AP-BIN-ITER22-01, on the
// operand list rather than inside it. `.claude/commands/` was named alone, so `.claude/agents/`
// (18 managed subagents) and `.claude/settings.json` were in NO published asset, and `templates/`
// was named nowhere at all. install.sh reads all three behind a silent skip -- `[ -d ]` at :614
// and :645, and `jq '.hooks.PreToolUse // [] | length' ... || echo "0"` at :762, which spends the
// same 0 on a MISSING source file as on a source carrying no hooks. MEASURED on the replayed
// asset: a tarball install registered ZERO PreToolUse hook groups (the source file carries exactly
// one -- the R-WSRC config-protection write guard), resolved no managed agent, and FATALed every
// microverse command, because resolveManagerPromptPath looks in $EXTENSION_ROOT/templates/ then
// ~/.claude/commands/ and install.sh rm -f's the second copy of microverse.md.
//
// The oracle is DERIVED on BOTH sides, so it carries no hand-maintained list to rot:
//   required = every literal `$SCRIPT_DIR/<path>` install.sh reads
//   minus     paths git does not track -- a tarball is built from a fresh checkout, so install.sh
//             already tolerates their absence (.git, whose absence IS the tarball-mode sentinel;
//             extension/.tsbuildinfo; node_modules)
//   minus     paths the tar invocation's OWN --exclude patterns prune (extension/src/**, whose
//             schema is staged onto the deployed path instead -- pinned separately above)
// Adding a deploy source to install.sh without carrying it reds this immediately.
const TAR_EXCLUDE_PREFIX = '--exclude=';

function workflowExcludePatterns() {
  return parseWorkflowTarOperands()
    .filter((operand) => operand.startsWith(TAR_EXCLUDE_PREFIX))
    .map((operand) => operand.slice(TAR_EXCLUDE_PREFIX.length));
}

function trackedIndex() {
  const listed = run('git', ['ls-files', '-z'], { cwd: REPO_ROOT });
  assert.equal(listed.status, 0, `could not read the git index: ${listed.stderr}`);
  const files = new Set(listed.stdout.split('\0').filter(Boolean));
  assert.ok(files.size > 100, `the git index reports only ${files.size} tracked files`);
  const directories = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return { files, directories };
}

// Stops at a quote, whitespace, `;`, `)` or a `$` interpolation, so only fully literal reads are
// claimed. A path built from a variable is out of the oracle's reach and is not asserted on.
const SCRIPT_DIR_READ_RE = /\$\{?SCRIPT_DIR\}?"?\/([^"\s;)$]+)/g;

function installDeploySources() {
  const install = readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  const literals = new Set();
  for (const match of install.matchAll(SCRIPT_DIR_READ_RE)) {
    literals.add(match[1].replace(/\/+$/, ''));
  }
  assert.ok(literals.size > 10, `parsed only ${literals.size} $SCRIPT_DIR reads from install.sh`);

  const { files, directories } = trackedIndex();
  const excludes = workflowExcludePatterns();
  assert.ok(excludes.length > 0, 'release.yml names no --exclude patterns — this oracle cannot excuse pruned reads');

  const expand = (literal) => {
    if (!literal.includes('*')) return [literal];
    const pattern = new RegExp(
      `^${literal.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    return [...files].filter((tracked) => pattern.test(tracked));
  };

  const required = new Set();
  for (const literal of literals) {
    for (const candidate of expand(literal)) {
      if (!files.has(candidate) && !directories.has(candidate)) continue;
      if (candidate.split('/').some((component) => excludes.includes(component))) continue;
      required.add(candidate);
    }
  }
  return [...required].sort();
}

function uncarriedDeploySources(members) {
  return installDeploySources().filter(
    (source) => !members.has(source) && ![...members].some((name) => name.startsWith(`${source}/`)),
  );
}

test('release-gate.the workflow asset carries every deploy source install.sh reads', () => {
  const required = installDeploySources();
  assert.ok(
    required.length >= 10,
    `derived only ${required.length} deploy sources from install.sh — the oracle is too thin to fire`,
  );

  assert.deepEqual(
    uncarriedDeploySources(workflowPayloadMembers()),
    [],
    'release.yml publishes an asset missing a path install.sh deploys from, and every consumer of'
      + ' that path skips silently',
  );
});

test('release-gate.the deploy-source oracle is disjoint from the import sweep and the post-tag check', () => {
  // Negative control. Amputating `.claude/` reds ONLY this oracle: no shipped `.js` imports from
  // it, so the import sweep stays green, and both members the post-tag gate reads survive.
  // Amputate MEMBERS, never the operand: an operand-level filter would stop matching the moment
  // the workflow respells the operand, and would then report "cannot fire" instead of controlling.
  const members = workflowPayloadMembers();
  const amputated = new Set([...members].filter((name) => !name.startsWith('.claude/')));
  assert.ok(
    members.size - amputated.size > 0,
    'the replayed payload carries no .claude/ members — the control cannot fire',
  );
  assert.ok(
    amputated.has('extension/package.json') && amputated.has('install.sh'),
    'the two members post-tag actually checks must survive the amputation, or the control proves nothing',
  );
  assert.deepEqual(
    unresolvedPayloadImports(amputated),
    [],
    'amputating .claude/ broke a static import — the control is not disjoint from the import sweep',
  );
  assert.ok(
    uncarriedDeploySources(amputated).includes('.claude/settings.json'),
    'amputating .claude/ left every deploy source carried — this oracle would not have caught the shipped defect',
  );
});
