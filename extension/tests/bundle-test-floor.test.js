// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBundleTestFloor,
  parseCommitTestDelta,
  parseRefinementBaseline,
  renderMorningSummaryFrontmatter,
} from '../services/bundle-finalize.js';

test('parseRefinementBaseline reads refinement-time baseline from summary frontmatter', () => {
  const summary = [
    '---',
    'test_baseline: 3404',
    'owner: bundle-finalize',
    '---',
    '# Refinement Summary',
  ].join('\n');

  assert.equal(parseRefinementBaseline(summary), 3404);
});

test('parseCommitTestDelta reads signed commit-message test delta tags', () => {
  assert.equal(parseCommitTestDelta('T1 add parser tests tests:+5'), 5);
  assert.equal(parseCommitTestDelta('T2 removes obsolete tests tests:-5'), -5);
  assert.equal(parseCommitTestDelta('T3 no test change tests:0'), 0);
  assert.equal(parseCommitTestDelta('T4 missing tag'), 0);
});

test('computeBundleTestFloor uses dynamic baseline plus scheduled ticket deltas', () => {
  const result = computeBundleTestFloor({
    refinementSummaryMarkdown: [
      '---',
      'test_baseline: 3404',
      '---',
      'body',
    ].join('\n'),
    totalTestCount: 3414,
    tickets: [
      { id: 't1', commitMessage: 'T1 tests:+5' },
      { id: 't2', commitMessage: 'T2 tests:+3' },
      { id: 't3', commitMessage: 'T3 tests:0' },
      { id: 't4', commitMessage: 'T4 tests:+2' },
    ],
  });

  assert.equal(result.baseline, 3404);
  assert.equal(result.delta, 10);
  assert.equal(result.floor, 3414);
  assert.equal(result.meetsFloor, true);
  assert.equal(result.netDeltaFromBaseline, 10);
});

test('computeBundleTestFloor treats dropped tickets as zero contribution', () => {
  const result = computeBundleTestFloor({
    baseline: 3404,
    totalTestCount: 3409,
    tickets: [
      { id: 'scheduled', commitMessage: 'scheduled tests:+5' },
      { id: 'dropped', status: 'dropped', commitMessage: 'dropped tests:+99' },
    ],
  });

  assert.equal(result.delta, 5);
  assert.equal(result.floor, 3409);
  assert.deepEqual(
    result.contributions.map((entry) => [entry.id, entry.delta, entry.included, entry.reason]),
    [
      ['scheduled', 5, true, 'scheduled'],
      ['dropped', 0, false, 'dropped'],
    ],
  );
});

test('computeBundleTestFloor excludes pre-shipped ticket additions', () => {
  const result = computeBundleTestFloor({
    baseline: 3404,
    totalTestCount: 3407,
    tickets: [
      { id: 'new-work', commitMessage: 'new work tests:+3' },
      { id: 'already-shipped', preShipped: true, commitMessage: 'already shipped tests:+8' },
    ],
  });

  assert.equal(result.delta, 3);
  assert.equal(result.floor, 3407);
  assert.equal(result.contributions.find((entry) => entry.id === 'already-shipped')?.delta, 0);
});

test('preShipped is the only pre-shipped source of truth — alias keys do not exclude a ticket', () => {
  const result = computeBundleTestFloor({
    baseline: 3404,
    tickets: [
      { id: 'snake-case-alias', pre_shipped: true, commitMessage: 'not excluded tests:+5' },
      { id: 'bare-shipped-alias', shipped: true, commitMessage: 'not excluded tests:+7' },
    ],
  });

  assert.equal(result.delta, 12);
  assert.equal(result.contributions.every((entry) => entry.included), true);
  assert.equal(result.contributions.every((entry) => entry.reason === 'scheduled'), true);
});

test('computeBundleTestFloor clamps negative net delta and emits a warning', () => {
  const result = computeBundleTestFloor({
    baseline: 3404,
    totalTestCount: 3399,
    tickets: [
      { id: 'removal', commitMessage: 'remove obsolete assertions tests:-5' },
    ],
  });

  assert.equal(result.delta, -5);
  assert.equal(result.floor, 3399);
  assert.equal(result.netDeltaFromBaseline, 0);
  assert.match(result.warnings.join('\n'), /net_delta_from_baseline clamped to 0/);
});

test('renderMorningSummaryFrontmatter prints the floor in YAML frontmatter', () => {
  const result = computeBundleTestFloor({
    baseline: 3404,
    totalTestCount: 3414,
    tickets: [
      { id: 't1', commitMessage: 'T1 tests:+5' },
      { id: 't2', commitMessage: 'T2 tests:+3' },
      { id: 't3', commitMessage: 'T3 tests:0' },
      { id: 't4', commitMessage: 'T4 tests:+2' },
    ],
  });

  const summary = renderMorningSummaryFrontmatter(result, '# Morning Summary\n');

  assert.match(summary, /^---\n/);
  assert.match(summary, /\ntest_baseline: 3404\n/);
  assert.match(summary, /\ntest_delta: 10\n/);
  assert.match(summary, /\ntest_floor: 3414\n/);
  assert.match(summary, /\nnet_delta_from_baseline: 10\n/);
  assert.match(summary, /\n---\n# Morning Summary\n$/);
});
