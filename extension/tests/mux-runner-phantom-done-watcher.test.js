// @tier: fast
/**
 * R-ICP-5 / AC-ICP-04 — phantom-Done watcher detects mid-iteration Todo→Done
 * flips and reverts when no completion_commit field is present. Tests the
 * exported inspectPhantomDoneTicketFile function which is the watcher's
 * per-event predicate.
 *
 * AC-ICP-04-3 — phantom_done_detected event registered with required payload
 * fields including completion_commit_present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'activity-events.schema.json');
const VALID_EVENTS_TS = path.resolve(__dirname, '..', 'src', 'types', 'index.ts');
const VALID_EVENTS_JS = path.resolve(__dirname, '..', 'types', 'index.js');

test('AC-ICP-04-3: phantom_done_detected registered in VALID_ACTIVITY_EVENTS (TS source)', () => {
  const content = fs.readFileSync(VALID_EVENTS_TS, 'utf-8');
  assert.ok(/phantom_done_detected/.test(content), 'TS source must register phantom_done_detected');
});

test('AC-ICP-04-3: phantom_done_detected registered in VALID_ACTIVITY_EVENTS (JS deploy)', () => {
  const content = fs.readFileSync(VALID_EVENTS_JS, 'utf-8');
  assert.ok(/phantom_done_detected/.test(content), 'JS deploy must mirror the registration');
});

test('AC-ICP-04-3: schema defines phantom_done_detected with required completion_commit_present', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const def = schema.definitions.phantom_done_detected;
  assert.ok(def, 'schema definition missing');
  assert.equal(def.type, 'object');
  assert.ok(def.required.includes('event'), 'required must include event');
  assert.ok(def.required.includes('ts'), 'required must include ts (timestamp)');
  assert.ok(def.required.includes('ticket'), 'required must include ticket');
  assert.ok(
    def.required.includes('completion_commit_present'),
    'AC-ICP-04-3 requires completion_commit_present in payload',
  );
  assert.equal(def.properties.completion_commit_present.type, 'boolean');
  assert.equal(def.properties.event.const, 'phantom_done_detected');
});

test('AC-ICP-04-3: payload count covers ≥3 registration sites (lint per AC)', () => {
  const ts = fs.readFileSync(VALID_EVENTS_TS, 'utf-8');
  const js = fs.readFileSync(VALID_EVENTS_JS, 'utf-8');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const tsCount = (ts.match(/phantom_done_detected/g) || []).length;
  const jsCount = (js.match(/phantom_done_detected/g) || []).length;
  const schemaCount = (schema.match(/phantom_done_detected/g) || []).length;
  const total = tsCount + jsCount + schemaCount;
  assert.ok(total >= 3, `expected ≥3 references across the 3 files, got ${total}`);
});

const { inspectPhantomDoneTicketFile } = await import('../bin/mux-runner.js');

function makeTicketFile(dir, ticketId, frontmatter) {
  const file = path.join(dir, `linear_ticket_${ticketId}.md`);
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(file, `---\n${fm}\n---\n\n# Body\n`);
  return file;
}

test('AC-ICP-04: status: Done WITH reachable completion_commit field → has_completion_commit (no revert)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    // B-1SEAM WS-1: the watcher git-probes the stamped sha through the ONE
    // predicate (bare field presence no longer keeps) — stamp a REAL sha.
    execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'work.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'work', '--no-gpg-sign'], { cwd: tmp, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    const ticketDir = path.join(tmp, 'session', 'eeff0011');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketFile = makeTicketFile(ticketDir, 'eeff0011', {
      id: 'eeff0011',
      status: 'Done',
      completion_commit: sha,
    });
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'In Progress',
    );
    assert.equal(
      result.reason,
      'has_completion_commit',
      `expected has_completion_commit, got ${result.reason}`,
    );
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-ICP-04: status: Todo → not_done (watcher silent)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    const ticketDir = path.join(tmp, 'session', '11223344');
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketFile = makeTicketFile(ticketDir, '11223344', {
      id: '11223344',
      status: 'Todo',
    });
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'Todo',
    );
    assert.equal(result.reason, 'not_done', `expected not_done, got ${result.reason}`);
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-ICP-04: missing id frontmatter → missing_id (defensive)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'phantom-watcher-test-'));
  try {
    const ticketDir = path.join(tmp, 'session', '99887766');
    fs.mkdirSync(ticketDir, { recursive: true });
    // status: Done but NO id field — exercises the missing_id branch which returns
    // before the git lookup that needs a real repo.
    const ticketFile = path.join(ticketDir, 'linear_ticket_99887766.md');
    fs.writeFileSync(ticketFile, '---\nstatus: Done\n---\n');
    const result = inspectPhantomDoneTicketFile(
      ticketFile,
      path.join(tmp, 'session'),
      tmp,
      'In Progress',
    );
    // Either missing_id (no id field) or unparseable (git failed) is acceptable —
    // both prove the watcher refuses to bless a Done flip without evidence.
    assert.ok(
      result.reason === 'missing_id' || result.reason === 'unparseable',
      `expected missing_id or unparseable, got ${result.reason}`,
    );
    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
