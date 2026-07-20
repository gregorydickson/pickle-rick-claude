// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseAndValidateArgs,
  enrichManifestTicketsFromSourcePrds,
} from '../bin/spawn-refinement-team.js';

// AP-EXT-RELPRD: a relative --prd used to survive parse (existsSync resolves it
// against cwd) and only blow up at manifest build, after every analyst cycle had
// already run. These cases pin the parse->manifest data path, not the parser alone.

function makePrdFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-relprd-'));
  const prdPath = path.join(dir, 'prd.md');
  fs.writeFileSync(prdPath, '# Bundle\n\nSome PRD prose.\n');
  return { dir, prdPath };
}

test('AP-EXT-RELPRD: a relative --prd is absolutized at parse time', () => {
  const { dir, prdPath } = makePrdFixture();
  try {
    // Relative to the real cwd, so no process.chdir (process-global-state race class).
    const relativePrd = path.relative(process.cwd(), prdPath);
    assert.equal(path.isAbsolute(relativePrd), false, 'fixture must be relative');

    const args = parseAndValidateArgs(['--prd', relativePrd, '--session-dir', dir]);

    assert.equal(path.isAbsolute(args.prdPath), true);
    assert.equal(fs.realpathSync(args.prdPath), fs.realpathSync(prdPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-RELPRD: parsed args from a relative --prd reach manifest build without throwing', () => {
  const { dir, prdPath } = makePrdFixture();
  try {
    const relativePrd = path.relative(process.cwd(), prdPath);
    const args = parseAndValidateArgs(['--prd', relativePrd, '--session-dir', dir]);

    // The exact consumer that used to throw ~15 min in, at buildRefinementManifest.
    assert.doesNotThrow(() => enrichManifestTicketsFromSourcePrds(args.prdPath, []));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-RELPRD: an absolute --prd is carried through unchanged', () => {
  const { dir, prdPath } = makePrdFixture();
  try {
    const args = parseAndValidateArgs(['--prd', prdPath, '--session-dir', dir]);

    assert.equal(args.prdPath, prdPath);
    assert.doesNotThrow(() => enrichManifestTicketsFromSourcePrds(args.prdPath, []));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
