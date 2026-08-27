// @tier: integration
// Integration-tiered (not fast): each test builds a real .tar.gz and drives the real
// `extractAndInstall`, which spawns `tar` and `bash install.sh` as subprocesses. Serialized
// via tests/integration/.serial-tests.json — the spawns are load-sensitive.
//
// These tests pin EXTRACTION-TIME CONTAINMENT, which `check-update.ts` inherits from tar's
// own defaults rather than implementing itself. That inheritance is the whole guarantee and
// nothing else enforces it: adding `-P` / `--absolute-names` to the extract args, or swapping
// `tar` for a JS tar library, silently removes it. Each case below goes red if that happens.
//
// ⚠️ TWO DIFFERENT `-P`s — DO NOT CONFLATE THEM. `stageDotSegmentTarball` passes `-P` when it
// CREATES its tarball, and that is mandatory: GNU tar strips a leading `../` from member names
// at CREATE time ("Removing leading `../' from member names", exit 0), so without `-P` the
// archive records a benign `ESCAPED_DOT.txt` and the adversarial case silently evaporates.
// Measured: bsdtar 3.5.3 preserves `../ESCAPED_DOT.txt` either way; GNU tar 1.34 preserves it
// only with `-P`. That asymmetry is why this file passed on macOS and failed on Linux CI — the
// fixture, not the guard, was platform-dependent.
// The `-P` the `src/bin/CLAUDE.md` trap door FORBIDS is `-P` on `extractInstallablePayload`'s
// EXTRACT args, which would disable tar's own containment. Creating an adversarial archive with
// `-P` is the opposite: it is what makes the guard testable at all. Never "clean up" the create
// flag, and never add the flag to the extract side.
//
// Every tarball here carries a VALID installable payload (`extension/package.json` +
// `install.sh` sharing one root), so `resolveInstallablePayloadRoot` accepts it. That matters:
// it proves these cases reach the extractor rather than dying at the payload-shape guard.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { extractAndInstall } from '../../bin/check-update.js';

let root;

function tar(args) {
  return execFileSync('tar', args, { encoding: 'utf-8', timeout: 30_000 });
}

/** Stage a valid installable payload and return its directory. */
function stagePayload() {
  const stage = fs.mkdtempSync(path.join(root, 'stage-'));
  fs.mkdirSync(path.join(stage, 'extension'), { recursive: true });
  fs.writeFileSync(
    path.join(stage, 'extension', 'package.json'),
    JSON.stringify({ version: '99.0.0' }),
  );
  fs.writeFileSync(path.join(stage, 'install.sh'), '#!/bin/bash\nexit 0\n');
  return stage;
}

/** A fresh directory to hold one tarball, so extractAndInstall's cleanup can't touch siblings. */
function tarballPath(name) {
  return path.join(fs.mkdtempSync(path.join(root, 'tarball-')), name);
}

/**
 * Build a tarball carrying a valid payload PLUS one member that escapes via a `../` segment,
 * and prove the escaping member survived into the archive. Returns the tarball and the outside
 * path that must stay absent.
 */
function stageDotSegmentTarball(escapedName) {
  const stage = stagePayload();
  // Record the member with its `../` prefix intact by naming it relative to the stage.
  fs.writeFileSync(path.join(stage, '..', escapedName), 'escaped\n');
  const outside = path.join(root, escapedName);

  const tarball = tarballPath('dot.tar.gz');
  // `-P` HERE IS ON THE CREATE, and is required — see the header note.
  tar(['czPf', tarball, '-C', stage, 'extension', 'install.sh', `../${escapedName}`]);

  // Fixture self-check. A tar that sanitizes at create time degrades this case to a benign
  // archive, and the fail-closed assertions below would then blame the guard for what is
  // actually a broken fixture. Fail here instead, with the correct attribution.
  const members = tar(['-tzf', tarball]).split('\n').filter(Boolean);
  assert.ok(
    members.includes(`../${escapedName}`),
    `FIXTURE DEFECT, not a guard failure: the archive must record the escaping member as `
      + `"../${escapedName}", so this tar sanitized it at create time despite -P. `
      + `Recorded members: ${JSON.stringify(members)}`,
  );

  fs.rmSync(outside, { force: true });
  return { tarball, outside };
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-containment-')));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('check-update extraction containment', () => {
  test('fails closed on a member whose path escapes via a dot segment', () => {
    const { tarball, outside } = stageDotSegmentTarball('ESCAPED_DOT.txt');

    const result = extractAndInstall(tarball);

    assert.equal(result.success, false, 'a dot-segment member must fail the upgrade closed');
    assert.match(result.error, /Extraction failed/);
    assert.equal(fs.existsSync(outside), false, 'nothing may land outside the extract dir');
  });

  test('fails closed on a member written through a symlink that escapes the extract dir', () => {
    // The member NAME (`evil/pwned.txt`) is entirely safe — no dot segment, no leading
    // slash — so a name-only `-tzf` scan cannot see this. Only the link's TARGET escapes.
    // `tar -r` appends to an uncompressed archive, which is how the symlink member is
    // ordered BEFORE the member that writes through it (portable across GNU and BSD tar).
    const victim = fs.mkdtempSync(path.join(root, 'victim-'));
    const stage = stagePayload();
    fs.symlinkSync(victim, path.join(stage, 'evil'));

    const through = fs.mkdtempSync(path.join(root, 'through-'));
    fs.mkdirSync(path.join(through, 'evil'));
    fs.writeFileSync(path.join(through, 'evil', 'pwned.txt'), 'owned\n');

    const dir = fs.mkdtempSync(path.join(root, 'tarball-'));
    const plain = path.join(dir, 'link.tar');
    tar(['cf', plain, '-C', stage, 'extension', 'install.sh', 'evil']);
    tar(['rf', plain, '-C', through, 'evil/pwned.txt']);
    execFileSync('gzip', [plain], { timeout: 30_000 });

    const result = extractAndInstall(`${plain}.gz`);

    assert.deepEqual(
      fs.readdirSync(victim), [],
      'no archive member may be written through a symlink into an outside directory',
    );
    assert.equal(result.success, false, 'a link-through member must fail the upgrade closed');
  });

  test('accepts a contained member whose name merely BEGINS with two dots', () => {
    // `..data/keep.txt` has NO `..` path segment — it is fully contained. This is the dual of
    // the classic segment-blind containment bypass (`'/a/bc'.startsWith('/a/b')` is true): any
    // future guard that string-matches `..` as a prefix, or prefix-tests the extract root
    // without a trailing separator, would FALSELY REJECT this member and turn this test red.
    // Measured accepted (exit 0) by both bsdtar 3.5.3 and GNU tar 1.34.
    const stage = stagePayload();
    fs.mkdirSync(path.join(stage, '..data'));
    fs.writeFileSync(path.join(stage, '..data', 'keep.txt'), 'keep\n');

    const tarball = tarballPath('dotprefix.tar.gz');
    tar(['czf', tarball, '-C', stage, 'extension', 'install.sh', '..data']);

    const result = extractAndInstall(tarball);

    assert.equal(
      result.success, true,
      `a contained '..'-prefixed member must not be rejected (error: ${result.error})`,
    );
  });

  test('fails closed on a dot-segment member when the extract root is reached through a symlink', () => {
    const { tarball, outside } = stageDotSegmentTarball('ESCAPED_SYMROOT.txt');

    // Point os.tmpdir() at a SYMLINK to a real directory, so check-update's extract root is
    // created under a symlinked prefix — the /tmp -> /private/tmp asymmetry, exercised against
    // the real code path because os.tmpdir() re-reads TMPDIR on every call.
    const realTmp = fs.mkdtempSync(path.join(root, 'realtmp-'));
    const linkedTmp = path.join(root, 'linked-tmp');
    fs.symlinkSync(realTmp, linkedTmp);

    const priorTmpdir = process.env.TMPDIR;
    let result;
    try {
      process.env.TMPDIR = linkedTmp;
      result = extractAndInstall(tarball);
    } finally {
      if (priorTmpdir === undefined) { delete process.env.TMPDIR; }
      else process.env.TMPDIR = priorTmpdir;
    }

    assert.equal(
      result.success, false,
      'a symlinked extract root must not weaken the dot-segment refusal',
    );
    assert.match(result.error, /Extraction failed/);
    assert.equal(fs.existsSync(outside), false, 'nothing may land outside the extract dir');
    assert.deepEqual(
      fs.readdirSync(realTmp), [],
      'the extract dir must be cleaned up even under a symlinked TMPDIR',
    );
  });
});
