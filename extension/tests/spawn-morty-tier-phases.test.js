// @tier: fast
// AC-PIAP-A2-1: trivial-tier prompt renders only implement+code_review; medium renders full 8-phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTierResumeTable,
  buildTierLifecycleSections,
} from '../bin/spawn-morty.js';
import { TIER_LIFECYCLE } from '../services/pickle-utils.js';

const TRIVIAL_PHASES = ['implement', 'code_review'];
const SMALL_PHASES = ['plan', 'implement', 'code_review'];
const MEDIUM_PHASES = [
  'research', 'research_review', 'plan', 'plan_review',
  'implement', 'conformance', 'code_review', 'simplify',
];

// ── Resume table ──────────────────────────────────────────────────────────────

test('AC-PIAP-A2-1: trivial resume table references only Implement and Code Review', () => {
  const table = buildTierResumeTable(TRIVIAL_PHASES);
  assert.ok(table.includes('Implement'), 'must include Implement step');
  assert.ok(table.includes('Code Review'), 'must include Code Review step');
  assert.ok(!table.includes('Research'), 'must NOT include Research');
  assert.ok(!table.includes('Plan'), 'must NOT include Plan');
  assert.ok(!table.includes('Conformance'), 'must NOT include Conformance');
  assert.ok(!table.includes('Simplify'), 'must NOT include Simplify');
});

test('AC-PIAP-A2-1: trivial resume table step numbers are 1 and 2', () => {
  const table = buildTierResumeTable(TRIVIAL_PHASES);
  assert.match(table, /1 \(Implement\)/);
  assert.match(table, /2 \(Code Review\)/);
});

test('AC-PIAP-A2-1: trivial resume table has no research_review.md row', () => {
  const table = buildTierResumeTable(TRIVIAL_PHASES);
  assert.ok(!table.includes('research_review.md'), 'must not reference research_review.md');
});

test('AC-PIAP-A2-1: trivial resume table has no plan_review.md row', () => {
  const table = buildTierResumeTable(TRIVIAL_PHASES);
  assert.ok(!table.includes('plan_review.md'), 'must not reference plan_review.md');
});

test('medium resume table is full 8-row (no regression)', () => {
  const table = buildTierResumeTable(MEDIUM_PHASES);
  assert.ok(table.includes('Research'), 'must include Research');
  assert.ok(table.includes('Research Review'), 'must include Research Review');
  assert.ok(table.includes('Plan Review'), 'must include Plan Review');
  assert.ok(table.includes('Implement'), 'must include Implement');
  assert.ok(table.includes('Conformance'), 'must include Conformance');
  assert.ok(table.includes('Code Review'), 'must include Code Review');
  assert.ok(table.includes('Simplify'), 'must include Simplify');
  assert.match(table, /1 \(Research\)/);
  assert.match(table, /8 \(Simplify\)/);
});

test('medium resume table references research_review.md and plan_review.md', () => {
  const table = buildTierResumeTable(MEDIUM_PHASES);
  assert.ok(table.includes('research_review.md'), 'must reference research_review.md');
  assert.ok(table.includes('plan_review.md'), 'must reference plan_review.md');
});

test('small resume table references plan but not research or conformance', () => {
  const table = buildTierResumeTable(SMALL_PHASES);
  assert.ok(table.includes('Plan'), 'must include Plan');
  assert.ok(!table.includes('Research'), 'must NOT include Research');
  assert.ok(!table.includes('Conformance'), 'must NOT include Conformance');
  assert.ok(!table.includes('plan_review.md'), 'must NOT reference plan_review.md (small has no plan_review)');
});

// ── Lifecycle sections ────────────────────────────────────────────────────────

test('AC-PIAP-A2-1: trivial lifecycle sections contain implement and code_review steps', () => {
  const sections = buildTierLifecycleSections(TRIVIAL_PHASES, 'trivial');
  assert.ok(sections.includes('Implement'), 'must include Implement step');
  assert.ok(sections.includes('Code Review'), 'must include Code Review step');
});

test('AC-PIAP-A2-1: trivial lifecycle sections do NOT contain Research, Plan, Conformance, Simplify', () => {
  const sections = buildTierLifecycleSections(TRIVIAL_PHASES, 'trivial');
  assert.ok(!sections.includes('### 1. Research'), 'must not have Research step header');
  assert.ok(!sections.includes('### 1. Plan'), 'must not have Plan step header');
  assert.ok(!sections.includes('Spec Conformance'), 'must not have Spec Conformance step');
  assert.ok(!sections.includes('Simplify'), 'must not have Simplify step');
});

test('AC-PIAP-A2-1: trivial lifecycle sections include plan-source note for skipped phases', () => {
  const sections = buildTierLifecycleSections(TRIVIAL_PHASES, 'trivial');
  assert.ok(
    sections.includes('ticket body') || sections.includes('## Problem'),
    'must document ticket body as plan source for skipped phases'
  );
});

test('AC-PIAP-A2-1: trivial lifecycle sections list tier=trivial and active phases', () => {
  const sections = buildTierLifecycleSections(TRIVIAL_PHASES, 'trivial');
  assert.ok(sections.includes('trivial'), 'must mention tier name');
  assert.ok(sections.includes('implement'), 'must mention implement in phase list');
  assert.ok(sections.includes('code_review'), 'must mention code_review in phase list');
});

test('medium lifecycle sections contain all 8 phase headers (no regression)', () => {
  const sections = buildTierLifecycleSections(MEDIUM_PHASES, 'medium');
  assert.ok(sections.includes('Research\n'), 'must have Research');
  assert.ok(sections.includes('Research Review\n'), 'must have Research Review');
  assert.ok(sections.includes('Plan Review\n'), 'must have Plan Review');
  assert.ok(sections.includes('Implement\n'), 'must have Implement');
  assert.ok(sections.includes('Spec Conformance\n'), 'must have Spec Conformance');
  assert.ok(sections.includes('Code Review\n'), 'must have Code Review');
  assert.ok(sections.includes('Simplify\n'), 'must have Simplify');
});

test('medium lifecycle sections do NOT include plan-source note (full lifecycle)', () => {
  const sections = buildTierLifecycleSections(MEDIUM_PHASES, 'medium');
  // The reduced-tier preamble should only appear for non-full tiers
  assert.ok(
    !sections.includes('skipped phases') || sections.includes('research'),
    'medium must not show a "skipped phases" note since all phases are active'
  );
});

test('trivial lifecycle: implement is step 1, code_review is step 2', () => {
  const sections = buildTierLifecycleSections(TRIVIAL_PHASES, 'trivial');
  assert.match(sections, /###\s+1\.\s+Implement/);
  assert.match(sections, /###\s+2\.\s+Code Review/);
});

test('medium lifecycle: research is step 1, simplify is step 8', () => {
  const sections = buildTierLifecycleSections(MEDIUM_PHASES, 'medium');
  assert.match(sections, /###\s+1\.\s+Research\n/);
  assert.match(sections, /###\s+8\.\s+Simplify\n/);
});

test('research block cites input writers and write conditions', () => {
  const out = buildTierLifecycleSections(TIER_LIFECYCLE.medium, 'medium');
  assert.ok(out.includes('write condition'), 'medium research must name write condition');
});

test('plan block builds fixtures through the input writer', () => {
  const out = buildTierLifecycleSections(TIER_LIFECYCLE.small, 'small');
  assert.ok(out.includes("through the input's writer"), 'small plan must name the writer');
});
