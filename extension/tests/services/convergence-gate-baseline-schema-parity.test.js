// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { runGate } from '../../services/convergence-gate.js';

const TYPES_PATH = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'types', 'index.ts',
);

// Derives the expected key set from the GateBaselineFile interface itself, rather than a
// hand-copied literal, so the test cannot silently drift from the type it claims to check.
function deriveGateBaselineFileKeys() {
  const source = fs.readFileSync(TYPES_PATH, 'utf-8');
  const match = source.match(/export interface GateBaselineFile\s*{([^}]*)}/s);
  assert.ok(match, `GateBaselineFile interface not found in ${TYPES_PATH}`);

  const required = new Set();
  const optional = new Set();
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) { continue; }
    const member = line.match(/^(\w+)(\?)?:/);
    if (!member) { continue; }
    (member[2] ? optional : required).add(member[1]);
  }
  return { required, optional };
}

test('baseline write: emitted JSON keys match GateBaselineFile type exactly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bl-parity-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'bl-parity-test', version: '1.0.0', scripts: {},
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");

    const baselinePath = path.join(dir, 'gate', 'baseline.json');
    await runGate({ workingDir: dir, mode: 'baseline', scope: 'full', checks: [], baselinePath });

    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    const actualKeys = new Set(Object.keys(raw));
    const { required, optional } = deriveGateBaselineFileKeys();
    const allKeys = new Set([...required, ...optional]);

    for (const key of required) {
      assert.ok(actualKeys.has(key), `GateBaselineFile required key missing from emitted JSON: ${key}`);
    }
    for (const key of actualKeys) {
      assert.ok(allKeys.has(key), `Unexpected extra key in emitted JSON (not in GateBaselineFile): ${key}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
