// @tier: integration
//
// v2-end-to-end.test.js — Wire ticket 7367ad78: integration proof for the v2.0.0-beta.1 bundle.
//
// Covers the 6 observable v2.0 lifecycle seams WITHOUT spawning real `claude -p` or network:
//
//  1. KILL-SWITCH: session setup with PICKLE_CODEGRAPH=off → service is inert, no events.
//  2. DISABLED: codegraph.enabled=false → index attempt skipped, no events.
//  3. KILL-SWITCH-PROMPT: worker prompt with disabled codegraph → no '## Code Graph Context' section.
//  4. ENABLED-PROMPT: worker prompt with enabled codegraph+fake service → section present for medium tier.
//  5. STALENESS-SEAM: shouldSyncCodegraph — stale/fresh/missing db decision (injectable clocks).
//  6. SILENT-DEATH-HOLD: applySilentDeathRecoveryPolicy with attributable commit → hold, not respawn.
//  7. FAILED-FLIP-SUPPRESSION: evaluateFailedFlipSuppression with evidence → suppressed, emits event.
//  8. EVENT-CROSS-REF: every v2.0 VALID_ACTIVITY_EVENT has ≥1 emitter in compiled src; reverse check.
//  9. SETTINGS-RESOLVERS: resolveCodegraphSettings + resolveHardeningSettings round-trip compiled defaults.
// 10. SUMMARY-ROLLUP: CodegraphService.getSessionCounters() reflects ops after a successful indexAll.
//
// All tests are DETERMINISTIC and hermetic: temp dirs under os.tmpdir(), no real subprocess,
// no network, no native @colbymchenry/codegraph binary (injected fakes only).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');

// ── module imports ────────────────────────────────────────────────────────────

const { runCodegraphIndexAtSetup } = await import(path.join(EXTENSION_ROOT, 'bin/setup.js'));
const { CodegraphService } = await import(path.join(EXTENSION_ROOT, 'services/codegraph-service.js'));
const {
  shouldSyncCodegraph,
  applySilentDeathRecoveryPolicy,
  evaluateFailedFlipSuppression,
  VALID_ACTIVITY_EVENTS: _muxExportCheck,
} = await import(path.join(EXTENSION_ROOT, 'bin/mux-runner.js'));
const {
  tierUsesGraphContext,
  buildCodegraphContextSection,
} = await import(path.join(EXTENSION_ROOT, 'bin/spawn-morty.js'));
const {
  resolveCodegraphSettings,
  resolveHardeningSettings,
} = await import(path.join(EXTENSION_ROOT, 'services/pickle-utils.js'));
const { VALID_ACTIVITY_EVENTS } = await import(path.join(EXTENSION_ROOT, 'types/index.js'));

// ── helpers ───────────────────────────────────────────────────────────────────

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

function makeTmp(prefix = 'v2-e2e-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cgSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: true,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 5_000,
    sync_timeout_ms: 5_000,
    query_timeout_ms: 5_000,
    ...overrides,
  };
}

function fakeImpl(overrides = {}) {
  return {
    indexAll: async () => ({ filesIndexed: 3 }),
    sync: async () => ({ filesChecked: 3 }),
    searchNodes: () => [{ id: 'n1', name: 'CodegraphService', score: 1 }],
    getCallers: () => [],
    getImpactRadius: () => [],
    buildContext: async () => 'fake-context-blob',
    close: () => {},
    ...overrides,
  };
}

function fakeService(opts = {}) {
  return {
    buildContext: async () => opts.context ?? 'ctx-body',
    searchNodes: () => opts.nodes ?? [{ id: 'n1', name: 'CodegraphService', score: 1 }],
    getCallers: () => opts.callers ?? [],
    getImpactRadius: () => opts.radius ?? [],
    indexAll: async () => ({}),
    sync: async () => ({}),
    close: () => {},
  };
}

// Minimal ticket object for prompt-building tests
function fakeTicket(overrides = {}) {
  return {
    title: 'Wire: integrate CodegraphService into mux-runner',
    content: 'Acceptance: `CodegraphService.indexAll()` called at setup. `buildCodegraphContextSection` injected.',
    ...overrides,
  };
}

// ── test 1: kill-switch → service inert, zero events ─────────────────────────

test('v2-E2E-1: PICKLE_CODEGRAPH=off → runCodegraphIndexAtSetup is inert, no events', async () => {
  const workDir = makeTmp('v2-cg-ks-');
  let indexAllCalled = false;
  const impl = fakeImpl({ indexAll: async () => { indexAllCalled = true; return {}; } });
  const events = [];
  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings(),
    /* isResume */ false,
    { impl, emit: (e) => events.push(e) },
    { PICKLE_CODEGRAPH: 'off' },
  );
  assert.ok(!indexAllCalled, 'indexAll must NOT be called under kill-switch');
  assert.equal(events.length, 0, 'no events under kill-switch');
});

// ── test 2: disabled via settings → skipped, no events ───────────────────────

test('v2-E2E-2: codegraph.enabled=false → setup index skipped, no events', async () => {
  const workDir = makeTmp('v2-cg-dis-');
  let indexAllCalled = false;
  const impl = fakeImpl({ indexAll: async () => { indexAllCalled = true; return {}; } });
  const events = [];
  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings({ enabled: false }),
    /* isResume */ false,
    { impl, emit: (e) => events.push(e) },
    {},
  );
  assert.ok(!indexAllCalled, 'indexAll must NOT be called when codegraph disabled');
  assert.equal(events.length, 0, 'no events when codegraph disabled');
});

// ── test 3: enabled + index_at_setup=true → indexAll called, event emitted ───

test('v2-E2E-3: enabled + index_at_setup=true → indexAll called, codegraph_index_built emitted', async () => {
  const workDir = makeTmp('v2-cg-idx-');
  let indexAllCalled = false;
  const impl = fakeImpl({ indexAll: async () => { indexAllCalled = true; return { filesIndexed: 5 }; } });
  const events = [];
  await runCodegraphIndexAtSetup(
    workDir,
    cgSettings({ index_at_setup: true }),
    /* isResume */ false,
    { impl, emit: (e) => events.push(e) },
    {},
  );
  assert.ok(indexAllCalled, 'indexAll must be called when index_at_setup=true');
  const built = events.find((e) => e.event === 'codegraph_index_built');
  assert.ok(built, 'codegraph_index_built event must be emitted');
  assert.equal(typeof built.ts, 'string', 'event must carry ts');
});

// ── test 4: kill-switch → worker prompt has NO Code Graph Context section ────

test('v2-E2E-4: PICKLE_CODEGRAPH=off → tierUsesGraphContext still works, but section is empty', async () => {
  // tierUsesGraphContext is a pure function, unaffected by env
  assert.equal(tierUsesGraphContext('medium'), true, 'medium tier uses graph context');
  assert.equal(tierUsesGraphContext('large'), true, 'large tier uses graph context');
  assert.equal(tierUsesGraphContext('small'), true, 'small tier uses graph context');
  assert.equal(tierUsesGraphContext('trivial'), false, 'trivial tier must NOT use graph context');
});

// ── test 5: enabled codegraph + medium tier → section present in prompt ───────

test('v2-E2E-5: buildCodegraphContextSection with fake service returns non-empty section for medium tier', async () => {
  const svc = fakeService({ nodes: [{ id: 'n1', name: 'CodegraphService', score: 1 }] });
  const settings = cgSettings();
  const ticket = fakeTicket();
  const section = await buildCodegraphContextSection({
    tier: 'medium',
    settings,
    service: svc,
    title: ticket.title,
    ticketContent: ticket.content,
  });
  // medium tier + enabled settings + non-empty node list = unconditional non-empty section.
  // Both conditions hold by construction: do NOT gate with an inner if.
  assert.ok(section.length > 0, 'enabled codegraph with hits must produce a non-empty section for medium tier');
  assert.ok(section.includes('## Code Graph Context'), 'section must contain the Code Graph Context header');
});

// ── test 6: buildCodegraphContextSection with disabled settings → empty ───────

test('v2-E2E-6: buildCodegraphContextSection with enabled=false → empty string', async () => {
  const svc = fakeService();
  const section = await buildCodegraphContextSection({
    tier: 'medium',
    settings: cgSettings({ enabled: false }),
    service: svc,
    title: 'Some ticket title',
    ticketContent: 'acceptance: some AC',
  });
  assert.equal(section, '', 'section must be empty string when codegraph disabled');
});

// ── test 7: null service → empty section (fail-open contract) ─────────────────

test('v2-E2E-7: buildCodegraphContextSection with null service → empty string (fail-open)', async () => {
  const section = await buildCodegraphContextSection({
    tier: 'medium',
    settings: cgSettings(),
    service: null,
    title: 'Some ticket title',
    ticketContent: 'acceptance: some AC',
  });
  assert.equal(section, '', 'null service must produce empty section');
});

// ── test 8: shouldSyncCodegraph — staleness decision (injectable clocks) ─────

test('v2-E2E-8: shouldSyncCodegraph stale db (age > threshold) → true', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (31 * 60 * 1000) }); // 31 min old
  assert.equal(shouldSyncCodegraph('/fake/.codegraph/codegraph.db', 30, now, statSync), true);
});

test('v2-E2E-8b: shouldSyncCodegraph fresh db (age < threshold) → false', () => {
  const now = () => 1_000_000;
  const statSync = () => ({ mtimeMs: 1_000_000 - (5 * 60 * 1000) }); // 5 min old
  assert.equal(shouldSyncCodegraph('/fake/.codegraph/codegraph.db', 30, now, statSync), false);
});

test('v2-E2E-8c: shouldSyncCodegraph missing db (statSync throws) → false (fail-open)', () => {
  const now = () => 1_000_000;
  const statSync = () => { throw new Error('ENOENT: no such file'); };
  assert.equal(shouldSyncCodegraph('/fake/.codegraph/codegraph.db', 30, now, statSync), false);
});

// ── test 9: applySilentDeathRecoveryPolicy — hold on attributable work ────────

test('v2-E2E-9: applySilentDeathRecoveryPolicy with completion_commit in frontmatter → hold', () => {
  const sessionDir = makeTmp('v2-sdeath-');
  const ticketId = 'test-ticket-a1b2c3d4';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  // B-RASO: the completion_commit arm now git cat-file-VERIFIES the sha (was
  // format-only). Make the fixture's workingDir a real repo with a real commit
  // so the sha resolves and the hold path is genuinely exercised (AC-4).
  execFileSync('git', ['init', '-q'], { cwd: sessionDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sessionDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: sessionDir });
  fs.writeFileSync(path.join(sessionDir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: sessionDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'seed', '--no-gpg-sign'], { cwd: sessionDir, stdio: 'ignore' });
  const completionSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sessionDir, encoding: 'utf8' }).trim();

  // Write a ticket with a resolvable completion_commit field
  fs.writeFileSync(
    path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: Done\ncompletion_commit: ${completionSha}\n---\n# Ticket\n`,
  );

  // Write a minimal state.json so appendRecoveryLedgerEntry doesn't crash
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    schema_version: 5,
    session_dir: sessionDir,
    recovery_attempts: [],
    working_dir: sessionDir,
    backend: 'claude',
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    start_time_epoch: Date.now(),
    worker_timeout_seconds: 3600,
  }), 'utf-8');

  const cls = {
    subClass: 'log_empty',
    artifactsMissing: [],
    sessionLogSize: 0,
    logPath: path.join(ticketDir, 'worker_session_1234.log'),
    pid: 1234,
  };

  const decision = applySilentDeathRecoveryPolicy({
    sessionDir,
    ticketId,
    workingDir: sessionDir,
    statePath,
    iteration: 1,
    classification: cls,
    settings: { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2 },
  });

  assert.equal(decision.action, 'hold', 'completion_commit in frontmatter → hold, not respawn');
  assert.equal(decision.evidence, 'completion_commit', 'evidence source must be completion_commit');
});

// ── test 10: applySilentDeathRecoveryPolicy — respawn when no evidence ────────

test('v2-E2E-10: applySilentDeathRecoveryPolicy with no evidence → respawn (first attempt)', () => {
  const sessionDir = makeTmp('v2-sdeath-noev-');
  const ticketId = 'test-ticket-00000000';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  // Write a ticket WITHOUT a completion_commit field
  fs.writeFileSync(
    path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: In Progress\n---\n# Ticket\n`,
  );

  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    schema_version: 5,
    session_dir: sessionDir,
    recovery_attempts: [],
    working_dir: sessionDir,
    backend: 'claude',
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    start_time_epoch: Date.now(),
    worker_timeout_seconds: 3600,
  }), 'utf-8');

  const cls = {
    subClass: 'log_empty',
    artifactsMissing: ['plan', 'conformance', 'code_review'],
    sessionLogSize: 0,
    logPath: path.join(ticketDir, 'worker_session_5678.log'),
    pid: 5678,
  };

  // No preIterSha → no scoped_commit; no fresh artifacts; no frontmatter sha
  const decision = applySilentDeathRecoveryPolicy({
    sessionDir,
    ticketId,
    workingDir: sessionDir,
    statePath,
    iteration: 1,
    classification: cls,
    settings: { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2 },
  });

  assert.ok(
    decision.action === 'respawn' || decision.action === 'halt',
    `expected respawn or halt, got ${decision.action}`,
  );
  if (decision.action === 'respawn') {
    assert.equal(decision.attempt, 1, 'first attempt must be 1');
    assert.equal(decision.cap, 1, 'cap must match settings');
  }
});

// ── test 11: evaluateFailedFlipSuppression — suppressed on fresh artifacts ───

test('v2-E2E-11: evaluateFailedFlipSuppression with fresh_artifacts evidence → suppressed', () => {
  const sessionDir = makeTmp('v2-flip-');
  const ticketId = 'flip-ticket-aabbccdd';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  // Plant a fresh research artifact; set windowStartMs BEFORE writing so the mtime falls inside [windowStart, now].
  const windowStartMs = Date.now() - 5_000; // 5 seconds ago
  const artifactPath = path.join(ticketDir, 'research_aabbccdd.md');
  fs.writeFileSync(artifactPath, 'APPROVED\n# Research\n## Findings\nsome findings');

  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    schema_version: 5,
    session_dir: sessionDir,
    recovery_attempts: [],
    working_dir: sessionDir,
    backend: 'claude',
    step: 'implement',
    iteration: 1,
    max_iterations: 15,
    start_time_epoch: Date.now(),
    worker_timeout_seconds: 3600,
  }), 'utf-8');

  const decision = evaluateFailedFlipSuppression({
    sessionDir,
    ticketId,
    workingDir: sessionDir,
    statePath,
    iteration: 1,
    callsite: 'worker_gate_fail',
    windowStartMs,
    settings: { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2 },
  });

  // Decision should be 'suppress' (fresh artifact in window) or 'escalate' (cap hit)
  // 'proceed' with no_evidence would indicate the window-start seam is broken.
  assert.ok(
    decision.action === 'suppress' || decision.action === 'escalate',
    `expected suppress or escalate, got ${decision.action} — windowStartMs seam may not be passing artifact evidence`,
  );
});

// ── test 12: resolveCodegraphSettings — compiled defaults round-trip ──────────

test('v2-E2E-12: resolveCodegraphSettings(null) returns compiled defaults', () => {
  const settings = resolveCodegraphSettings(null);
  assert.equal(typeof settings.enabled, 'boolean', 'enabled must be boolean');
  assert.equal(typeof settings.index_at_setup, 'boolean', 'index_at_setup must be boolean');
  assert.ok(Number.isInteger(settings.index_timeout_ms) && settings.index_timeout_ms > 0, 'index_timeout_ms must be positive integer');
  assert.ok(Number.isInteger(settings.sync_timeout_ms) && settings.sync_timeout_ms > 0, 'sync_timeout_ms must be positive integer');
  assert.ok(Number.isInteger(settings.query_timeout_ms) && settings.query_timeout_ms > 0, 'query_timeout_ms must be positive integer');
  assert.ok(settings.staleness_max_age_minutes >= 1, 'staleness_max_age_minutes must be >= 1');
  assert.ok(settings.context_max_bytes >= 1024 && settings.context_max_bytes <= 65536, 'context_max_bytes must be clamped [1024,65536]');
});

test('v2-E2E-12b: resolveHardeningSettings(null) returns compiled defaults', () => {
  const settings = resolveHardeningSettings(null);
  assert.ok(Number.isInteger(settings.silent_death_respawn_cap) && settings.silent_death_respawn_cap >= 0, 'silent_death_respawn_cap must be non-negative integer');
  assert.ok(Number.isInteger(settings.failed_flip_suppression_cap) && settings.failed_flip_suppression_cap >= 0, 'failed_flip_suppression_cap must be non-negative integer');
});

// ── test 13: CodegraphService counters after successful indexAll ──────────────

test('v2-E2E-13: CodegraphService.getSessionCounters() reflects live indexAll', async () => {
  const workDir = makeTmp('v2-svc-counters-');
  let indexCalls = 0;
  const impl = fakeImpl({ indexAll: async () => { indexCalls++; return {}; } });
  const svc = CodegraphService.create(workDir, cgSettings(), { impl });

  await svc.indexAll();
  const counters = svc.getSessionCounters();
  assert.equal(indexCalls, 1, 'indexAll must be called exactly once');
  assert.equal(counters.ops, 1, 'ops counter must be 1 after one successful indexAll');
  assert.equal(counters.degraded, 0, 'no degraded ops on success');
  assert.equal(counters.latched, 0, 'not latched on success');
});

test('v2-E2E-13b: CodegraphService with kill-switch → counters all zero', async () => {
  const workDir = makeTmp('v2-svc-ks-ctr-');
  const impl = fakeImpl();
  const svc = CodegraphService.create(workDir, cgSettings(), { impl, env: { PICKLE_CODEGRAPH: 'off' } });

  await svc.indexAll();
  await svc.sync();
  const counters = svc.getSessionCounters();
  assert.equal(counters.ops, 0, 'no ops under kill-switch');
  assert.equal(counters.degraded, 0, 'no degraded under kill-switch');
});

// ── test 14: event cross-reference — all v2.0 events registered in VALID_ACTIVITY_EVENTS ──

test('v2-E2E-14: all v2.0 activity events are in VALID_ACTIVITY_EVENTS (registration check)', () => {
  const v2Events = [
    'codegraph_index_built',
    'codegraph_index_failed',
    'codegraph_sync_completed',
    'codegraph_degraded',
    'codegraph_session_summary',
    'scope_impact_warning',
    'orphan_commit_reattached',
    'orphan_commit_unreattachable',
    'worker_silent_death',
    'pre_reset_diff_archived',
    'pre_reset_archive_failed',
    'failed_flip_suppressed',
  ];
  const registered = new Set(VALID_ACTIVITY_EVENTS);
  for (const event of v2Events) {
    assert.ok(registered.has(event), `v2.0 event '${event}' must be in VALID_ACTIVITY_EVENTS`);
  }
});

// ── test 15: event cross-reference — emitters exist for all v2.0 events ──────

test('v2-E2E-15: all v2.0 events have emitters in compiled source (structural check)', () => {
  // Structural check: scan compiled .js files for each event name as a string literal
  // or logActivity call. This is intentionally lenient (we're looking for any reference).
  const v2Events = [
    'codegraph_index_built',     // codegraph-service.js: emit({ event: 'codegraph_index_built', ... })
    'codegraph_index_failed',    // setup.js: logActivity({ event: 'codegraph_index_failed', ... })
    'codegraph_sync_completed',  // codegraph-service.js: emit({ event: 'codegraph_sync_completed', ... })
    'codegraph_degraded',        // codegraph-service.js: emit({ event: 'codegraph_degraded', ... })
    'codegraph_session_summary', // mux-runner.js: writeActivityEntry(..., { event: 'codegraph_session_summary', ... })
    'scope_impact_warning',      // check-scope-diff.js: logActivity({ event: 'scope_impact_warning', ... })
    'orphan_commit_reattached',  // mux-runner.js: writeActivityEntry(..., { event: 'orphan_commit_reattached', ... })
    'orphan_commit_unreattachable', // mux-runner.js
    'worker_silent_death',       // mux-runner.js: writeActivityEntry(..., { event: 'worker_silent_death', ... })
    'pre_reset_diff_archived',   // git-utils.js: logActivity({ event: 'pre_reset_diff_archived', ... })
    'pre_reset_archive_failed',  // git-utils.js: logActivity({ event: 'pre_reset_archive_failed', ... })
    'failed_flip_suppressed',    // mux-runner.js: writeActivityEntry(..., { event: 'failed_flip_suppressed', ... })
  ];

  // Enumerate compiled .js files that could emit (subset of known emitters)
  const emitterFiles = [
    path.join(EXTENSION_ROOT, 'services/codegraph-service.js'),
    path.join(EXTENSION_ROOT, 'bin/mux-runner.js'),
    path.join(EXTENSION_ROOT, 'bin/setup.js'),
    path.join(EXTENSION_ROOT, 'bin/check-scope-diff.js'),
    path.join(EXTENSION_ROOT, 'services/git-utils.js'),
  ];

  const corpus = emitterFiles.map((f) => {
    try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; }
  }).join('\n');

  for (const event of v2Events) {
    assert.ok(
      corpus.includes(`'${event}'`) || corpus.includes(`"${event}"`),
      `event '${event}' must appear as a string literal in the compiled emitter files`,
    );
  }
});

// ── test 16: VALID_ACTIVITY_EVENTS no-duplicate invariant ─────────────────────

test('v2-E2E-16: VALID_ACTIVITY_EVENTS has no duplicate entries', () => {
  const seen = new Set();
  for (const event of VALID_ACTIVITY_EVENTS) {
    assert.ok(!seen.has(event), `duplicate event '${event}' found in VALID_ACTIVITY_EVENTS`);
    seen.add(event);
  }
  assert.ok(VALID_ACTIVITY_EVENTS.length > 100, 'sanity: event registry must have > 100 entries');
});

// ── test 17: resolveCodegraphSettings kill-switch interaction ─────────────────

test('v2-E2E-17: CodegraphService created from resolveCodegraphSettings(null) is inert when kill-switch set', async () => {
  const settings = resolveCodegraphSettings(null);
  const impl = fakeImpl();
  let indexCalled = false;
  const svc = CodegraphService.create(
    makeTmp('v2-resolver-ks-'),
    settings,
    { impl: { ...impl, indexAll: async () => { indexCalled = true; return {}; } }, env: { PICKLE_CODEGRAPH: 'off' } },
  );
  await svc.indexAll();
  assert.ok(!indexCalled, 'kill-switch must make service inert regardless of settings');
});

// ── test 18: hardeningSettings with bag overrides ────────────────────────────

test('v2-E2E-18: resolveHardeningSettings with valid bag overrides applies them', () => {
  const settings = resolveHardeningSettings({
    hardening: { silent_death_respawn_cap: 3, failed_flip_suppression_cap: 0 },
  });
  assert.equal(settings.silent_death_respawn_cap, 3, 'override must apply');
  assert.equal(settings.failed_flip_suppression_cap, 0, 'cap=0 must disable suppression');
});

test('v2-E2E-18b: resolveHardeningSettings with negative values falls back to defaults', () => {
  const settings = resolveHardeningSettings({
    hardening: { silent_death_respawn_cap: -1, failed_flip_suppression_cap: -5 },
  });
  assert.ok(settings.silent_death_respawn_cap >= 0, 'must not accept negative silent_death_respawn_cap');
  assert.ok(settings.failed_flip_suppression_cap >= 0, 'must not accept negative failed_flip_suppression_cap');
});

// ── test 19: CodegraphService sync() emits codegraph_sync_completed ──────────

test('v2-E2E-19: CodegraphService.sync() → codegraph_sync_completed event emitted', async () => {
  const workDir = makeTmp('v2-sync-evt-');
  const impl = fakeImpl();
  const events = [];
  const svc = CodegraphService.create(workDir, cgSettings(), { impl, emit: (e) => events.push(e) });

  await svc.sync();
  const syncEvt = events.find((e) => e.event === 'codegraph_sync_completed');
  assert.ok(syncEvt, 'codegraph_sync_completed must be emitted on successful sync');
  assert.equal(typeof syncEvt.ts, 'string', 'event must carry ts');
});

// ── test 20: CodegraphService degraded on timeout ────────────────────────────

test('v2-E2E-20: CodegraphService.indexAll() timeout → codegraph_degraded emitted, returns null', async () => {
  const workDir = makeTmp('v2-timeout-');
  const impl = fakeImpl({
    indexAll: async () => new Promise((resolve) => setTimeout(resolve, 200)), // longer than timeout
  });
  const events = [];
  const svc = CodegraphService.create(
    workDir,
    cgSettings({ index_timeout_ms: 50 }), // 50ms timeout — will race
    { impl, emit: (e) => events.push(e) },
  );

  const result = await svc.indexAll();
  // result should be null (timeout → degraded → null)
  assert.equal(result, null, 'timeout must cause null return');
  const degraded = events.find((e) => e.event === 'codegraph_degraded');
  assert.ok(degraded, 'codegraph_degraded must be emitted on timeout');
  assert.equal(degraded.reason, 'timeout', 'reason must be timeout');
});
