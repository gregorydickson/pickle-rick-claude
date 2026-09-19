// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../src/bin/check-readiness.ts');

test('check-readiness contract resolution passes explicit one-hop timeout', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const FIND_IMPORTERS_TIMEOUT_MS = 3_000;/);
  assert.match(source, /computeOneHop\([^;]+findImportersTimeoutMs:\s*FIND_IMPORTERS_TIMEOUT_MS[^;]+\)/s);
});

// AP-EXT-ITER294-01: this assertion used to read `check-readiness.ts`, where the enumeration was a
// DIVERGENT COPY with no reachable caller — the pin was green over dead code, so the timeout it
// claimed to protect protected nothing. The copy is deleted; the pin now reads the ONE live
// enumeration, in the shared module every consumer actually resolves against.
const enumerationSourcePath = resolve(__dirname, '../src/services/signature-caller-gap.ts');

test('AP-EXT-ITER294-01: the single live tracked-file enumeration passes an explicit git timeout', () => {
  const source = readFileSync(enumerationSourcePath, 'utf8');

  assert.match(source, /const GIT_LS_FILES_TIMEOUT_MS = 30_000;/);
  assert.match(source, /spawnSync\('git', \['ls-files'\], \{[^}]+timeout:\s*GIT_LS_FILES_TIMEOUT_MS[^}]+\}\)/s);
});

test('check-readiness contract resolution has overall wall budget', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const DEFAULT_MAX_WALL_MS = 120_000;/);
  assert.match(source, /--max-wall-ms/);
  assert.match(source, /Date\.now\(\) > cache\.deadline/);
});

test('check-readiness filters doc-extension basenames before symbol resolution', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /DOC_EXTENSION_ALLOWLIST/);
  assert.match(source, /isDocExtensionBasename/);
});
