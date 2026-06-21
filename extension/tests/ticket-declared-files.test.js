// @tier: fast
//
// R-CECB: the per-ticket declared-files reader parses a ticket's `## Files to
// modify` / `## Files to create` / `## Implementation Details` heading sections
// AND `**Files to (modify|create)**:` inline-bold lines into the declared in-scope
// file-path set, ignoring dotted symbols and de-duping.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDeclaredFiles } from '../services/ticket-declared-files.js';

test('parses `## Files to modify` heading section backticked paths', () => {
  const md = [
    '# Ticket',
    '## Files to modify',
    '- `extension/src/services/foo.ts` — change the thing',
    '- `extension/src/services/bar.ts`',
    '## Next section',
    '- `extension/src/services/should-not-appear.ts`',
  ].join('\n');
  assert.deepEqual(readDeclaredFiles(md), [
    'extension/src/services/foo.ts',
    'extension/src/services/bar.ts',
  ]);
});

test('parses `## Files to create` heading section', () => {
  const md = ['## Files to create', 'Create `extension/tests/new.test.js` here.'].join('\n');
  assert.deepEqual(readDeclaredFiles(md), ['extension/tests/new.test.js']);
});

test('parses `## Implementation Details` section', () => {
  const md = [
    '## Implementation Details',
    '**Files to create**: `extension/src/services/reader.ts` (forward-created)',
    '**Files to modify**: `extension/src/services/evidence.ts` — add path',
  ].join('\n');
  assert.deepEqual(readDeclaredFiles(md), [
    'extension/src/services/reader.ts',
    'extension/src/services/evidence.ts',
  ]);
});

test('parses `**Files to modify**:` inline-bold label OUTSIDE a declared heading', () => {
  const md = [
    '# Ticket',
    'Some prose.',
    '**Files to modify**: `extension/src/services/inline.ts` — note',
    'More prose with `not-a-path-symbol` ignored.',
  ].join('\n');
  assert.deepEqual(readDeclaredFiles(md), ['extension/src/services/inline.ts']);
});

test('ignores dotted-symbol tokens (no slash, no known extension)', () => {
  const md = [
    '## Files to modify',
    '- `PickleType.someField` should be a symbol, not a path',
    '- `extension/src/x.ts` is a real path',
  ].join('\n');
  assert.deepEqual(readDeclaredFiles(md), ['extension/src/x.ts']);
});

test('strips a leading ./ and de-dupes', () => {
  const md = [
    '## Files to modify',
    '- `./extension/src/dup.ts`',
    '- `extension/src/dup.ts`',
  ].join('\n');
  assert.deepEqual(readDeclaredFiles(md), ['extension/src/dup.ts']);
});

test('recognizes bare-extension paths without a slash', () => {
  const md = ['## Files to create', '- `README.md`', '- `install.sh`'].join('\n');
  assert.deepEqual(readDeclaredFiles(md), ['README.md', 'install.sh']);
});

test('returns empty when no declared-file section exists', () => {
  const md = ['# Ticket', '## Problem', 'No files declared here. `some.symbol` only.'].join('\n');
  assert.deepEqual(readDeclaredFiles(md), []);
});
