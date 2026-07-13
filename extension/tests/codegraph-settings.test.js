// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Import compiled JS (tests run against compiled output)
const { resolveCodegraphSettings } = await import('../services/pickle-utils.js');

// Compiled defaults are OFF: absence of a settings file (or a malformed
// codegraph block) must never silently activate codegraph — the opt-in
// stance lives in BOTH the shipped pickle_settings.json AND the compiled
// fallback (the old enabled:true fallback leaked fixture-dir indexing from
// sandboxed test runs without a settings file).
const DEFAULTS = {
  enabled: false,
  index_at_setup: false,
  staleness_max_age_minutes: 30,
  context_max_bytes: 8192,
  expose_mcp_to_workers: false,
  index_timeout_ms: 120000,
  sync_timeout_ms: 30000,
  query_timeout_ms: 5000,
};

describe('resolveCodegraphSettings', () => {

  describe('absent/null/non-object bag → all defaults', () => {
    for (const input of [undefined, null, 42, 'string', [], true]) {
      it(`bag=${JSON.stringify(input)} → defaults`, () => {
        const result = resolveCodegraphSettings(input);
        assert.deepStrictEqual(result, DEFAULTS);
      });
    }
  });

  describe('absent codegraph block → all defaults', () => {
    it('empty object bag → defaults', () => {
      assert.deepStrictEqual(resolveCodegraphSettings({}), DEFAULTS);
    });
    it('bag with other keys but no codegraph → defaults', () => {
      assert.deepStrictEqual(resolveCodegraphSettings({ schema_version: 2, microverse: {} }), DEFAULTS);
    });
    it('null codegraph block → defaults', () => {
      assert.deepStrictEqual(resolveCodegraphSettings({ codegraph: null }), DEFAULTS);
    });
    it('non-object codegraph block (array) → defaults', () => {
      assert.deepStrictEqual(resolveCodegraphSettings({ codegraph: [] }), DEFAULTS);
    });
    it('non-object codegraph block (string) → defaults', () => {
      assert.deepStrictEqual(resolveCodegraphSettings({ codegraph: 'yes' }), DEFAULTS);
    });
  });

  describe('partial codegraph block → present keys used, absent keys default', () => {
    it('only enabled=true provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { enabled: true } });
      assert.deepStrictEqual(result, { ...DEFAULTS, enabled: true });
    });
    it('only index_at_setup=true provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_at_setup: true } });
      assert.deepStrictEqual(result, { ...DEFAULTS, index_at_setup: true });
    });
    it('only expose_mcp_to_workers=true provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { expose_mcp_to_workers: true } });
      assert.deepStrictEqual(result, { ...DEFAULTS, expose_mcp_to_workers: true });
    });
    it('only staleness_max_age_minutes=60 provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: 60 } });
      assert.deepStrictEqual(result, { ...DEFAULTS, staleness_max_age_minutes: 60 });
    });
    it('only context_max_bytes=4096 provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: 4096 } });
      assert.deepStrictEqual(result, { ...DEFAULTS, context_max_bytes: 4096 });
    });
    it('only index_timeout_ms=60000 provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_timeout_ms: 60000 } });
      assert.deepStrictEqual(result, { ...DEFAULTS, index_timeout_ms: 60000 });
    });
    it('only sync_timeout_ms=10000 provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { sync_timeout_ms: 10000 } });
      assert.deepStrictEqual(result, { ...DEFAULTS, sync_timeout_ms: 10000 });
    });
    it('only query_timeout_ms=2000 provided', () => {
      const result = resolveCodegraphSettings({ codegraph: { query_timeout_ms: 2000 } });
      assert.deepStrictEqual(result, { ...DEFAULTS, query_timeout_ms: 2000 });
    });
  });

  describe('malformed values → compiled defaults', () => {
    it('enabled="true" (string) → default false (malformed never activates)', () => {
      const result = resolveCodegraphSettings({ codegraph: { enabled: 'true' } });
      assert.strictEqual(result.enabled, false);
    });
    it('index_at_setup=1 (number) → default false (malformed never activates)', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_at_setup: 1 } });
      assert.strictEqual(result.index_at_setup, false);
    });
    it('expose_mcp_to_workers=null → default false', () => {
      const result = resolveCodegraphSettings({ codegraph: { expose_mcp_to_workers: null } });
      assert.strictEqual(result.expose_mcp_to_workers, false);
    });
    it('staleness_max_age_minutes="foo" → default 30', () => {
      const result = resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: 'foo' } });
      assert.strictEqual(result.staleness_max_age_minutes, 30);
    });
    it('staleness_max_age_minutes=1.5 (float) → default 30', () => {
      const result = resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: 1.5 } });
      assert.strictEqual(result.staleness_max_age_minutes, 30);
    });
    it('context_max_bytes="4096" (string) → default 8192', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: '4096' } });
      assert.strictEqual(result.context_max_bytes, 8192);
    });
    it('index_timeout_ms=null → default 120000', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_timeout_ms: null } });
      assert.strictEqual(result.index_timeout_ms, 120000);
    });
    it('sync_timeout_ms=Infinity → default 30000', () => {
      const result = resolveCodegraphSettings({ codegraph: { sync_timeout_ms: Infinity } });
      assert.strictEqual(result.sync_timeout_ms, 30000);
    });
    it('query_timeout_ms=NaN → default 5000', () => {
      const result = resolveCodegraphSettings({ codegraph: { query_timeout_ms: NaN } });
      assert.strictEqual(result.query_timeout_ms, 5000);
    });
  });

  describe('clamp matrix — floors', () => {
    it('staleness_max_age_minutes=0 → clamped to floor 1', () => {
      const result = resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: 0 } });
      assert.strictEqual(result.staleness_max_age_minutes, 1);
    });
    it('staleness_max_age_minutes=-5 → clamped to floor 1', () => {
      const result = resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: -5 } });
      assert.strictEqual(result.staleness_max_age_minutes, 1);
    });
    it('index_timeout_ms=100 (below 5000 floor) → clamped to 5000', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_timeout_ms: 100 } });
      assert.strictEqual(result.index_timeout_ms, 5000);
    });
    it('index_timeout_ms=0 → clamped to 5000', () => {
      const result = resolveCodegraphSettings({ codegraph: { index_timeout_ms: 0 } });
      assert.strictEqual(result.index_timeout_ms, 5000);
    });
    it('sync_timeout_ms=50 (below 1000 floor) → clamped to 1000', () => {
      const result = resolveCodegraphSettings({ codegraph: { sync_timeout_ms: 50 } });
      assert.strictEqual(result.sync_timeout_ms, 1000);
    });
    it('query_timeout_ms=100 (below 500 floor) → clamped to 500', () => {
      const result = resolveCodegraphSettings({ codegraph: { query_timeout_ms: 100 } });
      assert.strictEqual(result.query_timeout_ms, 500);
    });
    it('context_max_bytes=512 (below 1024 floor) → clamped to 1024', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: 512 } });
      assert.strictEqual(result.context_max_bytes, 1024);
    });
    it('context_max_bytes=1 → clamped to 1024', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: 1 } });
      assert.strictEqual(result.context_max_bytes, 1024);
    });
  });

  describe('clamp matrix — ceiling (context_max_bytes only)', () => {
    it('context_max_bytes=100000 (above 65536 ceiling) → clamped to 65536', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: 100000 } });
      assert.strictEqual(result.context_max_bytes, 65536);
    });
    it('context_max_bytes=65537 → clamped to 65536', () => {
      const result = resolveCodegraphSettings({ codegraph: { context_max_bytes: 65537 } });
      assert.strictEqual(result.context_max_bytes, 65536);
    });
  });

  describe('exact floor/ceiling boundary values are accepted unchanged', () => {
    it('staleness_max_age_minutes=1 (floor) → 1', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { staleness_max_age_minutes: 1 } }).staleness_max_age_minutes, 1);
    });
    it('context_max_bytes=1024 (floor) → 1024', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { context_max_bytes: 1024 } }).context_max_bytes, 1024);
    });
    it('context_max_bytes=65536 (ceiling) → 65536', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { context_max_bytes: 65536 } }).context_max_bytes, 65536);
    });
    it('index_timeout_ms=5000 (floor) → 5000', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { index_timeout_ms: 5000 } }).index_timeout_ms, 5000);
    });
    it('sync_timeout_ms=1000 (floor) → 1000', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { sync_timeout_ms: 1000 } }).sync_timeout_ms, 1000);
    });
    it('query_timeout_ms=500 (floor) → 500', () => {
      assert.strictEqual(resolveCodegraphSettings({ codegraph: { query_timeout_ms: 500 } }).query_timeout_ms, 500);
    });
  });

  describe('never throws', () => {
    const weirdInputs = [
      { codegraph: undefined },
      { codegraph: { enabled: undefined, index_timeout_ms: undefined } },
      { codegraph: { context_max_bytes: -Infinity } },
    ];
    for (const input of weirdInputs) {
      it(`does not throw for ${JSON.stringify(input)}`, () => {
        assert.doesNotThrow(() => resolveCodegraphSettings(input));
      });
    }
  });

  describe('source pickle_settings.json shape', () => {
    it('block present, dead keys absent, schema_version=2, no array values', () => {
      const s = require(path.resolve(__dirname, '../../pickle_settings.json'));
      assert.strictEqual(s.schema_version, 2, 'schema_version must be 2');
      assert.ok(s.codegraph && typeof s.codegraph === 'object', 'codegraph block must be present');
      assert.strictEqual('gitnexus_pinned_version' in s, false, 'gitnexus_pinned_version must be absent');
      assert.strictEqual('enable_graph_preflight' in s, false, 'enable_graph_preflight must be absent');
      // No array-valued keys in the codegraph block
      for (const [key, val] of Object.entries(s.codegraph)) {
        assert.ok(!Array.isArray(val), `codegraph.${key} must not be an array`);
      }
    });
  });

});
