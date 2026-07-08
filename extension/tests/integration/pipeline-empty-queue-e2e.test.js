// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { applyAllTicketsDoneCompletion } = await import(
  path.resolve(__dirname, '../../bin/mux-runner.js')
);

test('pipeline-empty-queue post-completion contract (AC-RTC-04)', async (t) => {
  const sessionRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-eq-')));
  const statePath = path.join(sessionRoot, 'state.json');

  try {
    for (const id of ['t1', 't2', 't3']) {
      const dir = path.join(sessionRoot, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, `rick_ticket_${id}.md`),
        `---\nid: ${id}\nstatus: Done\n---\n# T${id}\n`,
      );
    }

    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: sessionRoot,
      step: 'iteration',
      iteration: 1,
      max_iterations: 20,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null,
      original_prompt: 'empty-queue e2e canary',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionRoot,
      activity: [],
      schema_version: 3,
    }));

    applyAllTicketsDoneCompletion(statePath, sessionRoot, 1, () => {});

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    // AC-RTC-04 (a-d): one sub-test per sub-criterion
    await t.test('post-completion: state.activity contains kind:EPIC_COMPLETED', () => {
      assert.ok(
        Array.isArray(state.activity) && state.activity.some((a) => a.kind === 'EPIC_COMPLETED'),
        `expected activity entry with kind EPIC_COMPLETED but got ${JSON.stringify(state.activity)}`,
      );
    });

    let parsed;
    try { parsed = JSON.parse(state.completion_promise); } catch { parsed = null; }

    await t.test('post-completion: state.completion_promise.kind === EPIC_COMPLETED', () => {
      assert.equal(
        parsed?.kind,
        'EPIC_COMPLETED',
        `expected completion_promise.kind EPIC_COMPLETED but got ${state.completion_promise}`,
      );
    });

    await t.test('post-completion: state.completion_promise.reason === all-tickets-done', () => {
      assert.equal(
        parsed?.reason,
        'all-tickets-done',
        `expected completion_promise.reason all-tickets-done but got ${state.completion_promise}`,
      );
    });

    await t.test('post-completion: state.completion_promise.ts is round-trip-stable ISO-8601-Z', () => {
      // Date.parse() accepts non-ISO formats like RFC 2822 ("Mon May 04 2026 12:00:00 GMT-0700"),
      // locale strings ("5/4/2026"), and missing-Z forms ("2026-05-04 12:00:00") — all return
      // finite numbers, masking writer drift the AC explicitly forbids ("valid ISO-8601").
      // Round-trip via toISOString() is the strict test: only the canonical
      // YYYY-MM-DDTHH:mm:ss.sssZ form survives unchanged.
      const ts = parsed?.ts;
      assert.equal(typeof ts, 'string', `expected ts to be a string but got ${typeof ts}`);
      assert.equal(
        new Date(ts).toISOString(),
        ts,
        `expected completion_promise.ts to be round-trip-stable ISO-8601-Z but got ${ts}`,
      );
    });

    await t.test('post-completion: state.step === completed', () => {
      assert.equal(state.step, 'completed', `expected step=completed but got ${state.step}`);
    });

    await t.test('post-completion: state.exit_reason === completed', () => {
      assert.equal(
        state.exit_reason,
        'completed',
        `expected exit_reason=completed but got ${state.exit_reason}`,
      );
    });
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});
