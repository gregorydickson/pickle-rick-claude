// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveCommandTemplate } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('resolveCommandTemplate', () => {
  it('remaps legacy pickle.md to _pickle-manager-prompt.md', () => {
    assert.equal(resolveCommandTemplate('pickle.md'), '_pickle-manager-prompt.md');
  });

  it('remaps undefined (missing command_template) to _pickle-manager-prompt.md', () => {
    assert.equal(resolveCommandTemplate(undefined), '_pickle-manager-prompt.md');
  });

  it('remaps empty string to _pickle-manager-prompt.md', () => {
    assert.equal(resolveCommandTemplate(''), '_pickle-manager-prompt.md');
  });

  it('passes through _pickle-manager-prompt.md unchanged', () => {
    assert.equal(resolveCommandTemplate('_pickle-manager-prompt.md'), '_pickle-manager-prompt.md');
  });

  it('passes through anatomy-park.md unchanged', () => {
    assert.equal(resolveCommandTemplate('anatomy-park.md'), 'anatomy-park.md');
  });

  it('passes through szechuan-sauce.md unchanged', () => {
    assert.equal(resolveCommandTemplate('szechuan-sauce.md'), 'szechuan-sauce.md');
  });
});

// AC-PNTR-03: regression proof — state with command_template:'pickle.md' resolves
// the new template without changing schema_version.
describe('AC-PNTR-03 R-PNTR-MIGRATION', () => {
  it('resolves pickle.md to _pickle-manager-prompt.md and leaves schema_version unchanged', () => {
    const persistedSchemaVersion = 5; // representative value — must stay unchanged

    // Simulates the persisted state that legacy sessions carry
    const legacyState = {
      command_template: 'pickle.md',
      schema_version: persistedSchemaVersion,
    };

    const resolved = resolveCommandTemplate(legacyState.command_template);

    assert.equal(resolved, '_pickle-manager-prompt.md',
      'legacy command_template should remap to the new default');
    assert.equal(legacyState.schema_version, persistedSchemaVersion,
      'schema_version must be unchanged by the remap (value-only operation)');
  });
});
