// @tier: fast
//
// b1089e97 (CGH-2): conformance + behavioral trap-door for the
// `codegraph_context_injected` / `codegraph_context_skipped` activity events.
//
// Producer: spawn-morty.ts:buildCodegraphContextSection. Emission uses
// `writeActivityEntry`, which validates only the event NAME and does NOT
// auto-stamp `ts` (R-WSE-2) — the producer MUST pass `ts` explicitly.
// The schema requires `ts` for both events; the drop-field tests prove it.
//
// Mirrors worker-partial-lifecycle-exit-schema-conformance.test.js for the
// schema/registry/oneOf checks, then exercises the real producer for the
// skip-branch sweep, happy-path injected fixture, and disabled-suppression.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { buildCodegraphContextSection } from '../bin/spawn-morty.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
// Second committed schema copy: a $ref STUB, NOT a literal definition surface.
const ROOT_SCHEMA_PATH = path.join(ROOT, 'activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');
const SPAWN_MORTY_PATH = path.join(ROOT, 'src/bin/spawn-morty.ts');
const MUX_RUNNER_PATH = path.join(ROOT, 'src/bin/mux-runner.ts');

const EVENTS = ['codegraph_context_injected', 'codegraph_context_skipped'];

// Brace-depth body extractor: returns the source text between the matching `{`/`}`
// of the function body for the declaration matched by `declRe`. `declRe` MUST end at
// the body's opening `{` (the helper scans from there), so signatures whose return
// type itself contains braces — e.g. `): { injected: number; skipped: number } {` —
// must include that return type in the pattern. Bounds every emission/aggregation
// assertion to the target function body, never the whole file.
function extractFunctionBody(src, declRe) {
  const m = src.match(declRe);
  if (!m) return null;
  const startIdx = m.index + m[0].length;
  let depth = 1;
  let endIdx = startIdx;
  for (; endIdx < src.length && depth > 0; endIdx++) {
    const ch = src[endIdx];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return src.slice(startIdx, endIdx);
}

describe('codegraph context events: schema conformance', () => {
  it('schema defines both events with required ts', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

    const injected = schema.definitions.codegraph_context_injected;
    assert.ok(injected, 'schema must define codegraph_context_injected');
    assert.equal(injected.type, 'object');
    assert.deepEqual(
      injected.required.sort(),
      ['build_ms', 'bytes', 'event', 'hits_count', 'terms_count', 'ticket', 'tier', 'ts'],
    );
    assert.equal(injected.properties.event.const, 'codegraph_context_injected');
    assert.equal(injected.properties.ts.type, 'string');
    assert.equal(injected.properties.ticket.type, 'string');
    assert.equal(injected.properties.tier.type, 'string');
    assert.equal(injected.properties.terms_count.type, 'integer');
    assert.equal(injected.properties.hits_count.type, 'integer');
    assert.equal(injected.properties.bytes.type, 'integer');
    assert.equal(injected.properties.build_ms.type, 'integer');
    // AC-CGH-B2(b): `codegraph_context_injected` is an OPEN object, so an emit carrying
    // `dropped_stale` validates whether or not the schema NAMES it — the contract must
    // declare the property explicitly or an emit-only change never becomes contract.
    assert.equal(injected.properties.dropped_stale.type, 'integer',
      'schema must NAME dropped_stale on codegraph_context_injected (open-object silent-validation gap)');
    assert.equal(injected.properties.dropped_stale.minimum, 0);

    const skipped = schema.definitions.codegraph_context_skipped;
    assert.ok(skipped, 'schema must define codegraph_context_skipped');
    assert.deepEqual(skipped.required.sort(), ['event', 'reason', 'ts']);
    assert.equal(skipped.properties.event.const, 'codegraph_context_skipped');
    assert.equal(skipped.properties.ts.type, 'string');
    assert.deepEqual(
      skipped.properties.reason.enum.sort(),
      ['no_service', 'no_terms', 'non_graph_tier', 'query_failed', 'query_timeout', 'stale_refs', 'zero_hits'],
    );
    // AC-CGH-B2(c/d): the stale_refs skip carries optional `dropped_stale` (= full entry
    // count) + `ticket` attribution. Same open-object gap — the schema must NAME both or
    // the emit-only additions never become contract.
    assert.equal(skipped.properties.dropped_stale.type, 'integer',
      'schema must NAME dropped_stale on codegraph_context_skipped');
    assert.equal(skipped.properties.dropped_stale.minimum, 0);
    assert.equal(skipped.properties.ticket.type, 'string',
      'schema must NAME the optional ticket attribution on codegraph_context_skipped');
  });

  it('schema oneOf references both events (R-PDD-oneOf)', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    for (const ev of EVENTS) {
      assert.ok(
        refs.includes(`#/definitions/${ev}`),
        `oneOf must reference ${ev} so payload validation covers it`,
      );
    }
  });

  it('VALID_ACTIVITY_EVENTS registers both events', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    for (const ev of EVENTS) {
      assert.ok(new RegExp(`['"]${ev}['"]`).test(types), `src/types/index.ts must register ${ev}`);
    }
  });

  it('buildCodegraphContextSection stamps ts explicitly on both emits', () => {
    const src = readFileSync(SPAWN_MORTY_PATH, 'utf8');
    const body = extractFunctionBody(src, /export async function buildCodegraphContextSection\b[^{]*\{/);
    assert.ok(body, 'must find buildCodegraphContextSection declaration');
    assert.match(body, /event:\s*['"]codegraph_context_injected['"]/, 'must emit injected');
    assert.match(body, /event:\s*['"]codegraph_context_skipped['"]/, 'must emit skipped');
    const tsCount = (body.match(/ts:\s*new Date\(\)\.toISOString\(\)/g) || []).length;
    assert.ok(tsCount >= 2, `both emits must stamp ts explicitly (R-WSE-2), found ${tsCount}`);
  });

  it('drop-field: each event requires ts; valid payload satisfies required set', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const fixtures = {
      codegraph_context_injected: {
        event: 'codegraph_context_injected',
        ts: new Date().toISOString(),
        ticket: 'abc12345',
        tier: 'medium',
        terms_count: 3,
        hits_count: 5,
        bytes: 640,
        build_ms: 9,
      },
      codegraph_context_skipped: {
        event: 'codegraph_context_skipped',
        ts: new Date().toISOString(),
        reason: 'no_terms',
      },
    };
    for (const ev of EVENTS) {
      const def = schema.definitions[ev];
      const valid = fixtures[ev];
      for (const field of def.required) {
        assert.ok(field in valid, `valid ${ev} payload must include ${field}`);
      }
      const broken = { ...valid };
      delete broken.ts;
      const missing = def.required.filter((f) => !(f in broken));
      assert.deepEqual(missing, ['ts'], `schema must reject ${ev} without ts`);
    }
  });
});

// ── Parametrized: all THREE invariants asserted PER EVENT (AC-GA-CG-3) ──
//
// node:test has no `describe.each`, so this `for` loop over the two events IS the
// `describe.each([['codegraph_context_injected'], ['codegraph_context_skipped']])`
// the AC calls for: one describe block per event, one `it` per invariant.
for (const [ev] of [['codegraph_context_injected'], ['codegraph_context_skipped']]) {
  describe(ev, () => {
    it('invariant 1: registered in index.ts + both committed schema files', () => {
      const types = readFileSync(TYPES_PATH, 'utf8');
      assert.ok(
        new RegExp(`['"]${ev}['"]`).test(types),
        `src/types/index.ts (VALID_ACTIVITY_EVENTS) must register ${ev}`,
      );

      // Real schema (src/types/...): defines the event + references it from oneOf.
      const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
      assert.ok(schema.definitions?.[ev], `real schema must define ${ev}`);
      assert.ok(
        schema.oneOf.some((entry) => entry.$ref === `#/definitions/${ev}`),
        `real schema oneOf must reference ${ev}`,
      );

      // Second committed copy (repo-root extension/activity-events.schema.json) is a
      // 112-byte $ref STUB — it does NOT inline the definitions. The per-file invariant
      // is that its $ref is wired to the real schema that DOES define both events,
      // closing the "doubly fragile" gap (broken $ref OR dropped def).
      const stub = JSON.parse(readFileSync(ROOT_SCHEMA_PATH, 'utf8'));
      assert.equal(
        stub.$ref,
        './src/types/activity-events.schema.json',
        'root committed schema copy must $ref the real schema (which defines both events)',
      );
    });

    it('invariant 2: emitted from buildCodegraphContextSection with sessionDir+ticketId', () => {
      const body = extractFunctionBody(
        readFileSync(SPAWN_MORTY_PATH, 'utf8'),
        /export async function buildCodegraphContextSection\b[^{]*\{/,
      );
      assert.ok(body, 'must find buildCodegraphContextSection declaration');
      assert.match(body, new RegExp(`event:\\s*['"]${ev}['"]`), `must emit ${ev}`);
      // The producer threads both sessionDir (emit guard) and ticketId (injected payload).
      assert.match(body, /\bsessionDir\b/, 'producer must reference sessionDir');
      assert.match(body, /\bticketId\b/, 'producer must reference ticketId');
    });

    it('invariant 3: aggregated via countCodegraphContextEvents', () => {
      const body = extractFunctionBody(
        readFileSync(MUX_RUNNER_PATH, 'utf8'),
        // Return type `{ injected: number; skipped: number }` contains braces, so the
        // pattern must consume them and anchor on the body `{` that follows.
        /export function countCodegraphContextEvents\([\s\S]*?\}\s*\{/,
      );
      assert.ok(body, 'must find countCodegraphContextEvents declaration');
      assert.match(
        body,
        new RegExp(`entry\\?\\.event === ['"]${ev}['"]`),
        `countCodegraphContextEvents must aggregate ${ev}`,
      );
    });
  });
}

// ── Behavioral: real producer emits via writeActivityEntry into state.json ──

function makeSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: false,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 120000,
    sync_timeout_ms: 30000,
    query_timeout_ms: 5000,
    ...overrides,
  };
}

function fakeService({ hits = [], callers = [], summary = '', statusOverride = null } = {}) {
  return {
    // A1: the section builder now goes through the batched, killable runQueryBatch
    // boundary. `statusOverride` forces a timeout/failed discriminant so the two new
    // productive-skip branches (query_timeout / query_failed) can be exercised without
    // a real subprocess spawn.
    async runQueryBatch(searchTerms, callerIds) {
      if (statusOverride) return statusOverride;
      return {
        status: 'ok',
        searches: Object.fromEntries((searchTerms ?? []).map((t) => [t, hits])),
        callers: Object.fromEntries((callerIds ?? []).map((id) => [id, callers])),
      };
    },
    async buildContext() { return summary; },
    recordContextInjected() {},
    recordContextSkipped() {},
    close() {},
  };
}

function searchHit(id, name, score = 1) {
  return { node: { id, name, file: `${id}.ts`, line: 7 }, score };
}

function freshSession() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cg-events-'));
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ schema_version: 5, active: true, activity: [] }),
  );
  return dir;
}

function readActivity(sessionDir) {
  const state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

const TITLE = 'Inject `searchNodes` context';
const CONTENT = '---\nid: t1\n---\n# Body\n- AC uses `searchNodes` and `getCallers`';

describe('codegraph_context_skipped: branch sweep', () => {
  const cases = [
    {
      reason: 'no_service',
      build: () => ({ tier: 'medium', service: null, settings: makeSettings() }),
    },
    {
      reason: 'non_graph_tier',
      build: () => ({ tier: 'trivial', service: fakeService({ hits: [searchHit('n1', 'x')] }), settings: makeSettings() }),
    },
    {
      reason: 'no_terms',
      build: () => ({ tier: 'medium', service: fakeService({ hits: [searchHit('n1', 'x')] }), settings: makeSettings(), titleOverride: 'aa bb', contentOverride: 'cc dd' }),
    },
    {
      reason: 'zero_hits',
      build: () => ({ tier: 'medium', service: fakeService({ hits: [] }), settings: makeSettings() }),
    },
    {
      // A1: the batch runner group-killed a wedged query on timeout.
      reason: 'query_timeout',
      build: () => ({ tier: 'medium', service: fakeService({ statusOverride: { status: 'timeout', reason: 'grandchild-kill' } }), settings: makeSettings() }),
    },
    {
      // A1: the batch runner child crashed / ENOENT / emitted unparseable stdout.
      reason: 'query_failed',
      build: () => ({ tier: 'medium', service: fakeService({ statusOverride: { status: 'failed', reason: 'enoent' } }), settings: makeSettings() }),
    },
    {
      // 2e632f9a: node-level fs verification drops the only located hit (its cited
      // file doesn't exist under the fresh, empty `workingDir`).
      reason: 'stale_refs',
      build: () => ({
        tier: 'medium',
        service: fakeService({ hits: [searchHit('n1', 'x')] }),
        settings: makeSettings(),
        workingDir: mkdtempSync(path.join(os.tmpdir(), 'cg-events-stale-wd-')),
      }),
    },
  ];

  for (const c of cases) {
    it(`emits exactly one skipped event with reason=${c.reason}`, async () => {
      const sessionDir = freshSession();
      const cfg = c.build(sessionDir);
      const section = await buildCodegraphContextSection({
        tier: cfg.tier,
        title: cfg.titleOverride ?? TITLE,
        ticketContent: cfg.contentOverride ?? CONTENT,
        service: cfg.service,
        settings: cfg.settings,
        sessionDir,
        ticketId: 't1',
        workingDir: cfg.workingDir,
      });
      assert.equal(section, '', `${c.reason}: section must be empty`);
      const events = readActivity(sessionDir);
      const skipped = events.filter((e) => e.event === 'codegraph_context_skipped');
      assert.equal(skipped.length, 1, `${c.reason}: expected exactly one skipped event`);
      assert.equal(skipped[0].reason, c.reason, `${c.reason}: reason mismatch`);
      assert.ok(typeof skipped[0].ts === 'string' && skipped[0].ts.length > 0, `${c.reason}: ts must be stamped`);
      assert.equal(events.filter((e) => e.event === 'codegraph_context_injected').length, 0);
      if (c.reason === 'stale_refs') {
        assert.equal(skipped[0].dropped_stale, 1, 'stale_refs: dropped_stale must equal the dropped-node count');
      }
    });
  }
});

describe('codegraph_context: disabled suppression + happy path', () => {
  it('disabled branch emits NO skipped event', async () => {
    const sessionDir = freshSession();
    const section = await buildCodegraphContextSection({
      tier: 'medium',
      title: TITLE,
      ticketContent: CONTENT,
      service: fakeService({ hits: [searchHit('n1', 'x')] }),
      settings: makeSettings({ enabled: false }),
      sessionDir,
      ticketId: 't1',
    });
    assert.equal(section, '');
    const events = readActivity(sessionDir);
    assert.equal(events.filter((e) => e.event === 'codegraph_context_skipped').length, 0,
      'disabled branch must be suppressed (no skip event)');
    assert.equal(events.filter((e) => e.event === 'codegraph_context_injected').length, 0);
  });

  it('success path emits one injected event with all 8 fields, bytes post-cap, build_ms finite', async () => {
    const sessionDir = freshSession();
    const service = fakeService({
      hits: [searchHit('n1', 'fooFn', 5), searchHit('n2', 'barFn', 3)],
      callers: [{ node: { id: 'c1', name: 'callerA' } }],
      summary: 'context summary',
    });
    const settings = makeSettings();
    const section = await buildCodegraphContextSection({
      tier: 'medium',
      title: TITLE,
      ticketContent: CONTENT,
      service,
      settings,
      sessionDir,
      ticketId: 't1',
    });
    assert.ok(section.includes('## Code Graph Context'), 'section must be present');

    const injected = readActivity(sessionDir).filter((e) => e.event === 'codegraph_context_injected');
    assert.equal(injected.length, 1, 'exactly one injected event');
    const p = injected[0];
    for (const f of ['event', 'ts', 'ticket', 'tier', 'terms_count', 'hits_count', 'bytes', 'build_ms']) {
      assert.ok(f in p, `injected payload must carry ${f}`);
    }
    assert.equal(p.ticket, 't1');
    assert.equal(p.tier, 'medium');
    assert.equal(p.hits_count, 2, 'hits_count = ranked-hits length');
    assert.ok(p.terms_count >= 1, 'terms_count derived');
    assert.equal(p.bytes, Buffer.byteLength(section, 'utf-8'), 'bytes = POST-cap section byte length');
    assert.ok(Number.isFinite(p.build_ms) && p.build_ms >= 0, 'build_ms finite non-negative');
  });
});

// Sanity: omitting sessionDir must not throw and must not emit (unit-test path).
test('codegraph_context: missing sessionDir is best-effort no-op (no throw, no emit)', async () => {
  const section = await buildCodegraphContextSection({
    tier: 'medium',
    title: TITLE,
    ticketContent: CONTENT,
    service: fakeService({ hits: [] }),
    settings: makeSettings(),
    sessionDir: '',
    ticketId: 't1',
  });
  assert.equal(section, '', 'zero-hits still returns empty section');
});
