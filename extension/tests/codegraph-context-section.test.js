// @tier: fast
// 47047433 / C5: tier-conditional `## Code Graph Context` injection into buildWorkerPrompt.
// Relational oracle — NO committed baseline fixture; the section is computed in-test
// and the prompt diff is asserted to equal exactly the injected block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkerPrompt,
  buildCodegraphContextSection,
  deriveCodegraphTerms,
  renderCodegraphSection,
  tierUsesGraphContext,
} from '../bin/spawn-morty.js';
import { buildWorkerPrompt as refinementBuildWorkerPrompt, countContentLines } from '../bin/spawn-refinement-team.js';
import { countCodegraphContextEvents } from '../bin/mux-runner.js';

const SECTION_HEADER = '## Code Graph Context';
const TIERS = ['trivial', 'small', 'medium', 'large'];

// Hermetic HOME: buildWorkerPrompt reads ~/.claude/commands/send-to-morty.md. Plant a
// minimal template carrying the substitution placeholders so injection is deterministic
// regardless of whether install.sh has deployed the real template.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-section-home-'));
const cmdDir = path.join(tmpHome, '.claude', 'commands');
fs.mkdirSync(cmdDir, { recursive: true });
fs.writeFileSync(
  path.join(cmdDir, 'send-to-morty.md'),
  '# Worker Prompt\n{{TIER_RESUME_TABLE}}\n{{TIER_LIFECYCLE_SECTIONS}}\n',
);
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = tmpHome;
process.on('exit', () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

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

// Fake matching the CodegraphService surface (A1: the section builder queries via the
// batched, killable `runQueryBatch` boundary; buildContext stays async; close()). No real
// @colbymchenry/codegraph dependency. `hits`/`callers` map onto every requested term/id.
function fakeService({ hits = [], callers = [], summary = '' } = {}) {
  return {
    async runQueryBatch(searchTerms, callerIds) {
      return {
        status: 'ok',
        searches: Object.fromEntries((searchTerms ?? []).map((t) => [t, hits])),
        callers: Object.fromEntries((callerIds ?? []).map((id) => [id, callers])),
      };
    },
    async buildContext() { return summary; },
    close() {},
  };
}

function searchHit(id, name, score = 1) {
  return { node: { id, name, file: `${id}.ts`, line: 7 }, score };
}

function makeTicket(extra = {}) {
  return {
    task: 'Inject `Code Graph` context into worker prompt',
    ticketContent: '---\nid: t1\ntitle: Test\n---\n# Body\n- AC uses `searchNodes` and `getCallers`',
    ticketId: 't1',
    ticketPath: os.tmpdir(),
    sessionRoot: os.tmpdir(),
    backend: 'claude',
    isReviewTicket: false,
    ...extra,
  };
}

function buildPrompt(tier, codegraphSection) {
  return buildWorkerPrompt({
    ticket: makeTicket(),
    model: 'sonnet',
    repoRoot: os.tmpdir(),
    complexityTier: tier,
    codegraphSection,
  });
}

// ── AC: tier matrix ─────────────────────────────────────────────────────────
test('tier matrix: trivial → no section; small/medium/large → section present', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5)], callers: [{ node: { id: 'c1', name: 'callerA' } }], summary: 'sum' });
  const settings = makeSettings();
  for (const tier of TIERS) {
    const section = await buildCodegraphContextSection({
      tier, title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
    });
    if (tier === 'trivial') {
      assert.equal(section, '', 'trivial tier must yield no section');
      assert.equal(tierUsesGraphContext(tier), false);
    } else {
      assert.ok(section.includes(SECTION_HEADER), `${tier} tier must include section header`);
      assert.equal(tierUsesGraphContext(tier), true);
    }
    const promptOn = buildPrompt(tier, section);
    if (tier === 'trivial') assert.ok(!promptOn.includes(SECTION_HEADER));
    else assert.ok(promptOn.includes(SECTION_HEADER));
  }
});

// ── AC: relational oracle ───────────────────────────────────────────────────
test('relational oracle: diff(enabled, disabled) == exactly the injected section', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5), searchHit('n2', 'barFn', 3)], callers: [{ node: { id: 'c1', name: 'callerA' } }] });
  const settings = makeSettings();
  for (const tier of TIERS) {
    const section = await buildCodegraphContextSection({
      tier, title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
    });
    const promptOn = buildPrompt(tier, section);
    const promptOff = buildPrompt(tier, '');
    if (tier === 'trivial') {
      assert.equal(section, '');
      assert.equal(promptOn, promptOff, 'trivial diff must be empty');
    } else {
      assert.notEqual(promptOn, promptOff);
      assert.equal(promptOn.replace(section, ''), promptOff, 'prompt diff must equal exactly the section');
      assert.equal(promptOn.indexOf(section), promptOn.lastIndexOf(section), 'section injected exactly once');
    }
  }
});

// ── AC: cap + symbol-boundary truncation ────────────────────────────────────
test('cap: oversized results → output ≤ cap, ends at symbol boundary + [truncated]', async () => {
  const hits = [];
  for (let i = 0; i < 60; i++) hits.push(searchHit(`n${i}`, `symbolNumber${i}`, 60 - i));
  const bigSummary = Array.from({ length: 40 }, (_, i) => `summary line ${i} with extra words to consume bytes`).join('\n');
  const service = fakeService({ hits, callers: [{ node: { id: 'c', name: 'someCaller' } }], summary: bigSummary });
  const cap = 400;
  const settings = makeSettings({ context_max_bytes: cap });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
  });
  assert.ok(section.length > 0, 'section must be present');
  assert.ok(Buffer.byteLength(section, 'utf-8') <= cap, `section bytes (${Buffer.byteLength(section, 'utf-8')}) must be ≤ cap (${cap})`);
  assert.ok(section.includes('[truncated]'), 'truncated output must carry the marker');
  assert.ok(section.endsWith('[truncated]\n'), 'marker must be the final line (no split entry)');
  // No partial entry: every non-empty, non-header, non-marker line is a complete entry
  // (begins with "Summary:" or "- `").
  for (const line of section.split('\n')) {
    if (line === '' || line === SECTION_HEADER || line === '[truncated]') continue;
    assert.ok(line.startsWith('Summary:') || line.startsWith('- `'), `unexpected partial line: ${JSON.stringify(line)}`);
  }
});

test('renderCodegraphSection: whole section fits → no marker; degenerate cap → empty', () => {
  const fit = renderCodegraphSection(['- `a`', '- `b`'], 8192);
  assert.ok(fit.includes(SECTION_HEADER) && fit.includes('- `a`') && fit.includes('- `b`'));
  assert.ok(!fit.includes('[truncated]'));
  assert.equal(renderCodegraphSection(['- `a`'], 5), '', 'header alone over cap → empty');
});

// ── REGRESSION (anatomy-park): empty render under the byte cap is a SKIP, not a
//    phantom injection. acbf4225 emitted codegraph_context_injected (counter++ +
//    event with bytes:0, hits_count>0) even when renderCodegraphSection returned ''
//    because no entry fit under context_max_bytes — nothing reached the prompt, yet
//    the codegraph efficacy metric counted an injection. Data flow under test:
//    buildCodegraphContextSection emit → state.json activity → countCodegraphContextEvents.
function seedState(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false, working_dir: sessionDir, step: 'implement', iteration: 0,
    max_iterations: 100, max_time_minutes: 720, worker_timeout_seconds: 1200,
    start_time_epoch: 1000, completion_promise: null, original_prompt: 'cg empty-render test',
    current_ticket: null, history: [], started_at: new Date().toISOString(),
    session_dir: sessionDir, schema_version: 3, tmux_mode: false, chain_meeseeks: false,
    backend: 'claude', activity: [],
  }, null, 2));
  return statePath;
}

function spyService({ hits, summary }) {
  const calls = { injected: 0, skipped: 0 };
  return {
    service: {
      async runQueryBatch(searchTerms, callerIds) {
        return {
          status: 'ok',
          searches: Object.fromEntries((searchTerms ?? []).map((t) => [t, hits])),
          callers: Object.fromEntries((callerIds ?? []).map((id) => [id, [{ node: { id: 'c', name: 'someCaller' } }]])),
        };
      },
      async buildContext() { return summary; },
      recordContextInjected() { calls.injected += 1; },
      recordContextSkipped() { calls.skipped += 1; },
      close() {},
    },
    calls,
  };
}

test('empty render under tiny cap → SKIP (no phantom injection), normal cap → INJECT', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-render-'));
  try {
    const hits = [searchHit('n1', 'fooFn', 5), searchHit('n2', 'barFn', 3)];
    const summary = 'a long enough summary to guarantee non-empty entries before the cap is applied';

    // Tiny cap: not even the section header fits → renderCodegraphSection returns ''.
    const tiny = spyService({ hits, summary });
    const tinyState = seedState(sessionDir);
    const tinySection = await buildCodegraphContextSection({
      tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
      service: tiny.service, settings: makeSettings({ context_max_bytes: 8 }),
      sessionDir, ticketId: 'tcap',
    });
    assert.equal(tinySection, '', 'nothing fits under the cap → empty section');
    assert.equal(tiny.calls.injected, 0, 'must NOT record an injection when nothing was injected');
    assert.equal(tiny.calls.skipped, 1, 'empty render must record a skip');
    const tinyActivity = JSON.parse(fs.readFileSync(tinyState, 'utf8')).activity;
    assert.ok(tinyActivity.some((e) => e.event === 'codegraph_context_skipped'),
      'must emit codegraph_context_skipped');
    assert.ok(!tinyActivity.some((e) => e.event === 'codegraph_context_injected'),
      'must NOT emit a phantom codegraph_context_injected');
    assert.deepEqual(countCodegraphContextEvents(tinyActivity), { injected: 0, skipped: 1 },
      'consumer-side count must reflect the skip, not a phantom injection');

    // Adequate cap: the happy path still injects (guard against over-correction).
    const wide = spyService({ hits, summary });
    fs.rmSync(path.join(sessionDir, 'state.json'));
    const wideState = seedState(sessionDir);
    const wideSection = await buildCodegraphContextSection({
      tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
      service: wide.service, settings: makeSettings({ context_max_bytes: 8192 }),
      sessionDir, ticketId: 'twide',
    });
    assert.ok(wideSection.includes(SECTION_HEADER), 'adequate cap → real section injected');
    assert.equal(wide.calls.injected, 1, 'happy path must still record an injection');
    assert.equal(wide.calls.skipped, 0, 'happy path must not record a skip');
    const wideActivity = JSON.parse(fs.readFileSync(wideState, 'utf8')).activity;
    assert.deepEqual(countCodegraphContextEvents(wideActivity), { injected: 1, skipped: 0 });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── AC (2e632f9a): node-level staleness verification ─────────────────────────
// `workingDir` gates the feature: absent/empty means no filtering (every other test
// in this file omits it and is unaffected). These tests wire a real tmp working tree
// so stale (missing-file / out-of-range-line) node claims are provably dropped.

function makeWorkingDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-staleness-wd-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('staleness: node citing a missing file is dropped, fresh sibling survives (injected branch carries dropped_stale)', async () => {
  const workingDir = makeWorkingDir({ 'real.ts': 'line1\nline2\nline3\n' });
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-staleness-inject-'));
  const statePath = seedState(sessionDir);
  const service = fakeService({
    hits: [
      { node: { id: 'n1', name: 'freshFn', file: 'real.ts', line: 2 }, score: 5 },
      { node: { id: 'n2', name: 'staleFn', file: 'missing.ts', line: 3 }, score: 3 },
    ],
  });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings(), sessionDir, ticketId: 'tinject', workingDir,
  });
  assert.ok(section.includes('freshFn'), 'surviving node must render');
  assert.ok(!section.includes('staleFn'), 'stale-file node must be dropped');
  // AC-CGH-B2 "both branches": the INJECTED branch (survivors present) must still carry the
  // dropped-node count. The stale_refs SKIP branch is covered elsewhere; this exercises the
  // dropped_stale transformation end-to-end on the branch where a section IS emitted.
  const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
  const injected = activity.filter((e) => e.event === 'codegraph_context_injected');
  assert.equal(injected.length, 1, 'exactly one injected event (survivor present)');
  assert.equal(injected[0].dropped_stale, 1, 'dropped_stale must equal the dropped-node count on the injected branch');
  assert.equal(injected[0].hits_count, 2, 'hits_count is the pre-drop ranked-hits length (1 dropped + 1 survivor)');
  assert.equal(activity.filter((e) => e.event === 'codegraph_context_skipped').length, 0,
    'a surviving node must NOT emit a skip event');
});

test('staleness: two nodes citing the same file get independent per-line verdicts (stat cache correctness)', async () => {
  const workingDir = makeWorkingDir({ 'shared.ts': 'line1\nline2\nline3\n' });
  const service = fakeService({
    hits: [
      { node: { id: 'n1', name: 'freshInShared', file: 'shared.ts', line: 2 }, score: 5 },
      { node: { id: 'n2', name: 'staleInShared', file: 'shared.ts', line: 500 }, score: 3 },
    ],
  });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings(), workingDir,
  });
  assert.ok(section.includes('freshInShared'), 'in-range node on a shared file must survive');
  assert.ok(!section.includes('staleInShared'), 'out-of-range node on the SAME shared file must still be dropped');
});

test('staleness: node whose line exceeds the file line count is dropped', async () => {
  const workingDir = makeWorkingDir({ 'real.ts': 'line1\nline2\nline3\n' });
  const service = fakeService({
    hits: [
      { node: { id: 'n1', name: 'freshFn', file: 'real.ts', line: 2 }, score: 5 },
      { node: { id: 'n2', name: 'staleLineFn', file: 'real.ts', line: 999 }, score: 3 },
    ],
  });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings(), workingDir,
  });
  assert.ok(section.includes('freshFn'), 'surviving node must render');
  assert.ok(!section.includes('staleLineFn'), 'out-of-range-line node must be dropped');
});

test('staleness: all located nodes stale → stale_refs skip, dropped_stale == count, no injected event', async () => {
  const workingDir = makeWorkingDir({});
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-staleness-session-'));
  const statePath = seedState(sessionDir);
  const service = fakeService({
    hits: [
      { node: { id: 'n1', name: 'staleFnA', file: 'missing-a.ts', line: 1 }, score: 5 },
      { node: { id: 'n2', name: 'staleFnB', file: 'missing-b.ts', line: 1 }, score: 3 },
    ],
  });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings(), sessionDir, ticketId: 'tstale', workingDir,
  });
  assert.equal(section, '', 'all-stale must yield an empty section');
  const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
  const skipped = activity.filter((e) => e.event === 'codegraph_context_skipped');
  assert.equal(skipped.length, 1, 'exactly one skipped event');
  assert.equal(skipped[0].reason, 'stale_refs', 'reason must be stale_refs, not zero_hits');
  assert.equal(skipped[0].dropped_stale, 2, 'dropped_stale must equal the dropped-node count');
  assert.equal(activity.filter((e) => e.event === 'codegraph_context_injected').length, 0,
    'must NOT emit a codegraph_context_injected event');
});

test('staleness: all located nodes dropped + Summary present → still stale_refs, no phantom Summary-only injection', async () => {
  const workingDir = makeWorkingDir({});
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-staleness-summary-session-'));
  const statePath = seedState(sessionDir);
  const service = fakeService({
    hits: [{ node: { id: 'n1', name: 'staleFn', file: 'missing.ts', line: 1 }, score: 5 }],
    summary: 'a summary that would otherwise render on its own',
  });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings(), sessionDir, ticketId: 'tsummary', workingDir,
  });
  assert.equal(section, '', 'Summary alone must not render/inject when every located node is stale');
  const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
  const skipped = activity.filter((e) => e.event === 'codegraph_context_skipped');
  assert.equal(skipped.length, 1, 'exactly one skipped event');
  assert.equal(skipped[0].reason, 'stale_refs');
  assert.equal(skipped[0].dropped_stale, 1);
  assert.equal(activity.filter((e) => e.event === 'codegraph_context_injected').length, 0,
    'must NOT emit a codegraph_context_injected event for Summary-only content');
});

// The post-render twin of the staleness case above: there the located nodes are dropped
// BEFORE the render, here they are dropped BY it. renderCodegraphSection enforces the byte
// cap by popping trailing entries, so a Summary that leads would starve out every symbol
// and still return a non-empty section — passing both skip gates and reaching
// recordContextInjected() with an event claiming hits_count: 60 over zero rendered symbols.
test('cap: long Summary must not starve out every symbol entry — no phantom Summary-only injection', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cap-starve-session-'));
  const statePath = seedState(sessionDir);
  const hits = [];
  for (let i = 0; i < 60; i++) hits.push(searchHit(`n${i}`, `symbolNumber${i}`, 60 - i));
  const bigSummary = Array.from({ length: 40 }, (_, i) => `summary line ${i} with extra words to consume bytes`).join('\n');
  const service = fakeService({ hits, callers: [{ node: { id: 'c', name: 'someCaller' } }], summary: bigSummary });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
    service, settings: makeSettings({ context_max_bytes: 400 }), sessionDir, ticketId: 'tcap',
  });

  const bodyLines = section.split('\n').filter((l) => l !== '' && l !== SECTION_HEADER && l !== '[truncated]');
  const symbolLines = bodyLines.filter((l) => l.startsWith('- `'));
  assert.ok(symbolLines.length > 0,
    'a rendered section must carry at least one symbol entry — the payload, not just Summary prose');

  // The injected event is the efficacy metric the default-on decision rides on: it may only
  // fire over a section that actually named symbols.
  const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
  const injected = activity.filter((e) => e.event === 'codegraph_context_injected');
  assert.equal(injected.length, 1, 'exactly one injected event');
  assert.ok(injected[0].bytes > 0, 'injected event must report the real section bytes');
});

// ── AC: absence (zero hits / null / disabled / kill-switch) ──────────────────
test('absence: zero hits / null service / disabled → NO section header anywhere', async () => {
  const base = { tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent };
  const cases = [
    { name: 'zero hits', service: fakeService({ hits: [] }), settings: makeSettings() },
    { name: 'null service', service: null, settings: makeSettings() },
    { name: 'disabled', service: fakeService({ hits: [searchHit('n1', 'x')] }), settings: makeSettings({ enabled: false }) },
    { name: 'kill-switch/degraded (null returns)', service: fakeService({ hits: null }), settings: makeSettings() },
  ];
  for (const c of cases) {
    const section = await buildCodegraphContextSection({ ...base, service: c.service, settings: c.settings });
    assert.equal(section, '', `${c.name}: expected absent section`);
    const prompt = buildPrompt('medium', section);
    assert.ok(!prompt.includes(SECTION_HEADER), `${c.name}: prompt must not contain section header`);
  }
});

// ── AC: term derivation ─────────────────────────────────────────────────────
test('term derivation: backticked symbols + title nouns, deduped, ≤ 8', () => {
  const title = 'Refactor `parseScope` and `resolveScope` plus `parseScope` again for scope resolver clarity';
  const ac = 'Verify `parseScope`, `filterByPaths`, `computeOneHop`, `refreshScope`, `writeScopeArchive`, `buildScopeV1Schema`, `validateScope`';
  const terms = deriveCodegraphTerms(title, ac);
  assert.ok(terms.length <= 8, `expected ≤ 8 terms, got ${terms.length}`);
  assert.equal(new Set(terms).size, terms.length, 'terms must be deduped');
  assert.ok(terms.includes('parseScope'), 'backticked symbol from title must be present');
  assert.ok(terms.includes('filterByPaths'), 'backticked symbol from ACs must be present');
  // Backticked symbols are derived before title nouns.
  assert.ok(terms.indexOf('parseScope') < terms.length);
  // A title noun (length ≥ 4, non-stopword) is captured.
  const allTerms = deriveCodegraphTerms('Refactor the scopeResolver module', '');
  assert.ok(allTerms.includes('Refactor') || allTerms.includes('scopeResolver') || allTerms.includes('module'),
    'title nouns must be captured');
});

// ── AC: refinement-team builder untouched ───────────────────────────────────
test('refinement-team builder contains no graph section', () => {
  const prompt = refinementBuildWorkerPrompt('requirements', '# PRD\nSome content', path.join(os.tmpdir(), 'out.md'), os.tmpdir(), 1);
  assert.ok(!prompt.includes(SECTION_HEADER), 'refinement prompt must not contain Code Graph Context');
});

// ── LLM-conformance evidence: section adjacent to lifecycle sections ─────────
test('medium-tier section is adjacent to the tier lifecycle sections', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5)], callers: [{ node: { id: 'c1', name: 'callerA' } }] });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings: makeSettings(),
  });
  const prompt = buildPrompt('medium', section);
  const lifecycleIdx = prompt.indexOf('### 1. Research');
  const sectionIdx = prompt.indexOf(SECTION_HEADER);
  assert.ok(lifecycleIdx >= 0, 'medium prompt must contain the Research lifecycle section');
  assert.ok(sectionIdx > lifecycleIdx, 'Code Graph Context must follow the lifecycle sections (adjacent injection)');
});

// ── AP-EXT-ITER2-01: staleness verification counts CONTENT lines, not split length ──
// `split('\n').length` counts a phantom trailing empty element on every newline-terminated
// file, so a node citing exactly ONE line past EOF read FRESH, survived the filter, and was
// rendered into the worker prompt as a live symbol ref while `dropped_stale` under-counted.
// Relational oracle: the expected count is derived in-test from the same `countContentLines`
// oracle production now uses, so the fixture cannot decouple into a hardcoded twin. The
// discriminating value is `contentLines + 1` — the only one the naive count accepted.
const LINE_COUNT_CASES = [
  { name: 'trailing newline (LF)', body: 'line1\nline2\nline3\n', expectedLines: 3 },
  { name: 'trailing newline (CRLF)', body: 'line1\r\nline2\r\nline3\r\n', expectedLines: 3 },
  { name: 'no trailing newline (control)', body: 'line1\nline2\nline3', expectedLines: 3 },
];

for (const { name, body, expectedLines } of LINE_COUNT_CASES) {
  test(`staleness line count: ${name} — node one line past EOF is STALE, last real line is FRESH`, async () => {
    assert.equal(countContentLines(body), expectedLines, 'fixture precondition: oracle line count');
    const pastEof = expectedLines + 1;
    const workingDir = makeWorkingDir({ 'real.ts': body });
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-linecount-'));
    const statePath = seedState(sessionDir);
    try {
      const section = await buildCodegraphContextSection({
        tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
        service: fakeService({
          hits: [
            { node: { id: 'n1', name: 'lastRealLineFn', file: 'real.ts', line: expectedLines }, score: 5 },
            { node: { id: 'n2', name: 'pastEofFn', file: 'real.ts', line: pastEof }, score: 3 },
          ],
        }),
        settings: makeSettings(), sessionDir, ticketId: 'tlinecount', workingDir,
      });
      assert.ok(section.includes('lastRealLineFn'),
        `node citing the last real line (${expectedLines}) must survive as fresh`);
      assert.ok(!section.includes('pastEofFn'),
        `node citing line ${pastEof} in a ${expectedLines}-line file must be dropped as stale`);
      // The telemetry half: dropped_stale feeds the codegraph efficacy metric, so an
      // under-count silently inflates apparent index freshness.
      const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
      const injected = activity.filter((e) => e.event === 'codegraph_context_injected');
      assert.equal(injected.length, 1, 'exactly one injected event (a survivor is present)');
      assert.equal(injected[0].dropped_stale, 1, 'dropped_stale must count the past-EOF node');
    } finally {
      fs.rmSync(workingDir, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
}

test('staleness line count: every node one line past EOF → stale_refs skip, no phantom injection', async () => {
  const body = 'line1\nline2\n';
  const pastEof = countContentLines(body) + 1;
  const workingDir = makeWorkingDir({ 'real.ts': body });
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-linecount-skip-'));
  const statePath = seedState(sessionDir);
  try {
    const section = await buildCodegraphContextSection({
      tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent,
      service: fakeService({
        hits: [
          { node: { id: 'n1', name: 'ghostA', file: 'real.ts', line: pastEof }, score: 5 },
          { node: { id: 'n2', name: 'ghostB', file: 'real.ts', line: pastEof }, score: 3 },
        ],
      }),
      settings: makeSettings(), sessionDir, ticketId: 'tlinecountskip', workingDir,
    });
    assert.equal(section, '', 'zero located survivors must yield an empty section');
    const activity = JSON.parse(fs.readFileSync(statePath, 'utf8')).activity;
    const skipped = activity.filter((e) => e.event === 'codegraph_context_skipped');
    assert.equal(skipped.length, 1, 'exactly one skip event');
    assert.equal(skipped[0].reason, 'stale_refs', 'reason must be stale_refs, not zero_hits');
    assert.equal(skipped[0].dropped_stale, 2, 'dropped_stale must equal the dropped-node count');
    assert.equal(activity.filter((e) => e.event === 'codegraph_context_injected').length, 0,
      'no phantom injection built from dead refs');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
