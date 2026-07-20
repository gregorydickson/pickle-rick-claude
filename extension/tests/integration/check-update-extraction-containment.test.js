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
// Every tarball here carries a VALID installable payload (`extension/package.json` +
// `install.sh` sharing one root), so `resolveInstallablePayloadRoot` accepts it. That matters:
// it proves these cases reach the extractor rather than dying at the payload-shape guard.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { extractAndInstall } from '../../bin/check-update.js';

let root;

function tar(args) {
  execFileSync('tar', args, { timeout: 30_000 });
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

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-containment-')));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('check-update extraction containment', () => {
  let victim;

  beforeEach(() => {
    victim = fs.mkdtempSync(path.join(root, 'victim-'));
  });

  test('fails closed on a member whose path escapes via a dot segment', () => {
    const stage = stagePayload();
    // Record the member with its `../` prefix intact by naming it relative to the stage.
    fs.writeFileSync(path.join(stage, '..', 'ESCAPED_DOT.txt'), 'escaped\n');
    const outside = path.join(root, 'ESCAPED_DOT.txt');

    const tarball = tarballPath('dot.tar.gz');
    tar(['czf', tarball, '-C', stage, 'extension', 'install.sh', '../ESCAPED_DOT.txt']);
    fs.rmSync(outside, { force: true });

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
});
