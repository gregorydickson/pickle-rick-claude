// @tier: fast
// AC-PIAP-A2-1: trivial-tier prompt renders only implement+code_review; medium renders full 8-phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildTierResumeTable,
  buildTierLifecycleSections,
  buildWorkerPrompt,
  evaluateWorkerOutcome,
  persistWorkerOutcomeStatus,
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

// One lifecycle step's body: from its `### N. <title>` heading to the next heading.
function lifecycleSection(out, title) {
  const heading = new RegExp(`### \\d+\\. ${title}\\n`).exec(out);
  assert.ok(heading, `lifecycle must contain a "${title}" step`);
  const start = heading.index + heading[0].length;
  const next = out.indexOf('\n### ', start);
  return out.slice(start, next === -1 ? out.length : next);
}

test('research block cites input writers and write conditions', () => {
  const out = buildTierLifecycleSections(TIER_LIFECYCLE.medium, 'medium');
  const research = lifecycleSection(out, 'Research');
  assert.ok(research.includes('write condition'), 'medium Research step must name write condition');
  assert.match(research, /every writer/, 'medium Research step must require citing every writer');
  assert.doesNotMatch(research, /cite its writer/, 'the single-writer sentence is replaced, not kept beside the new rule');
  assert.match(research, /values that writer can store \(including NULL\)/, 'each writer names the values it can store');
  // Research review fails research that proposes solutions, so the fixture-building clause must stay out of it.
  assert.ok(!research.includes("through the input's writer"), 'fixture clause must not appear in the Research step');
  assert.ok(
    lifecycleSection(out, 'Plan').includes("through the input's writer"),
    'medium Plan step must name the writer',
  );
});

test('plan block builds fixtures through the input writer', () => {
  const out = buildTierLifecycleSections(TIER_LIFECYCLE.small, 'small');
  const plan = lifecycleSection(out, 'Plan');
  assert.ok(plan.includes("through the input's writer"), 'small Plan step must name the writer');
  assert.match(plan, /one test fixture per writer/, 'small Plan step must build a fixture for each writer, not one');
});

test('Implement and Code Review sections warn against growing guard exception lists', () => {
  const text = buildTierLifecycleSections(MEDIUM_PHASES, 'medium');
  const implement = lifecycleSection(text, 'Implement');
  const review = lifecycleSection(text, 'Code Review');
  assert.match(implement, /allowlist/i);
  assert.match(review, /allowlist/i);
});

test('Spec Conformance requires verifier-chosen bounded guard mutants with a safe restore', () => {
  const text = buildTierLifecycleSections(MEDIUM_PHASES, 'medium');
  const conformance = lifecycleSection(text, 'Spec Conformance');
  assert.match(conformance, /mutants: /);
  assert.match(conformance, /at most 5/);
  assert.match(conformance, /test FILES/);
  assert.match(conformance, /git diff --quiet/);
  assert.doesNotMatch(conformance, /git checkout --/);
});

test('the verifier agent carries the same exception-list and guard-mutant rules as the worker prompt', () => {
  const verifier = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../.claude/agents/morty-phase-verifier.md'), 'utf-8');
  assert.match(verifier, /an allowlist, uncovered-files or known-exceptions list, or a baseline — is not a fix/);
  assert.match(verifier, /record a necessary exception with its reason as an open finding/);
  assert.match(verifier, /`mutants: K of M`/);
  assert.match(verifier, /at most 5/);
  assert.match(verifier, /test FILES \(never a whole tier\)/);
  assert.match(verifier, /git diff --quiet -- <path>/);
  assert.match(verifier, /Never undo a mutant with git (?:check)out or git restore/);
});

// ── Lifecycle re-run of committed work ────────────────────────────────────────

const RERUN_SHA = 'abc1234def5678';
const rerunPrompt = (frontmatterExtra) => buildWorkerPrompt({
  ticket: {
    task: 'task body', ticketId: 'rr01', ticketPath: '/tmp/rr01', sessionRoot: '/tmp/rr-session',
    backend: 'claude', isReviewTicket: false,
    ticketContent: `---\nid: rr01\nstatus: "Todo"\n${frontmatterExtra}---\n# body\n`,
  },
  model: 'm',
  complexityTier: 'medium',
});

test('re-run of committed ticket skips Implement and names the sha', () => {
  const table = buildTierResumeTable(MEDIUM_PHASES, true);
  assert.doesNotMatch(table, /\(Implement\)/);
  assert.doesNotMatch(table, /\(Conformance\)|\(Code Review\)|\(Simplify\)/);
  assert.match(table, /\(Plan Review\)/);
  const prompt = rerunPrompt(`completion_commit: ${RERUN_SHA}\nlifecycle_rerun: requested\n`);
  assert.ok(prompt.includes(RERUN_SHA), 'prompt must name the committed sha');
  assert.match(prompt, /ONLY the missing pre-implementation artifacts/);
});

test('re-run of committed ticket renders no Implement or Code Review section that would contradict its banner', () => {
  const prompt = rerunPrompt(`completion_commit: ${RERUN_SHA}\nlifecycle_rerun: requested\n`);
  assert.doesNotMatch(prompt, /### \d+\. Implement\n/);
  assert.doesNotMatch(prompt, /### \d+\. Code Review\n/);
  assert.match(prompt, /### \d+\. Plan Review\n/, 'the pre-implementation sections still render');
});

test('control: every tier lifecycle renders its Implement and Code Review sections', () => {
  for (const [tier, phases] of Object.entries(TIER_LIFECYCLE)) {
    const sections = buildTierLifecycleSections(phases, tier);
    assert.match(sections, /### \d+\. Implement\n/, `tier ${tier} lacks Implement`);
    assert.match(sections, /### \d+\. Code Review\n/, `tier ${tier} lacks Code Review`);
  }
});

test('control: lifecycle_rerun requested with no completion_commit is not a re-run of committed work', () => {
  const prompt = rerunPrompt('lifecycle_rerun: requested\n');
  assert.ok(!prompt.includes('Lifecycle re-run of committed work'), 'no commit to describe, so no re-run banner');
  assert.match(prompt, /\|\s*\d+ \(Implement\)\s*\|/, 'the resume table keeps its Implement row');
});

test('control: ticket without lifecycle_rerun keeps the unchanged table', () => {
  assert.equal(buildTierResumeTable(MEDIUM_PHASES, false), buildTierResumeTable(MEDIUM_PHASES));
  const prompt = rerunPrompt(`completion_commit: ${RERUN_SHA}\n`);
  assert.ok(!prompt.includes('Lifecycle re-run of committed work'));
  assert.match(prompt, /\(Implement\)/);
});

// ── Worker outcome floor is unchanged by the lifecycle re-run ─────────────────
// The Done-flip guard parks a committed ticket missing its tier artifacts; the worker's own
// outcome stays on the any-of artifact floor, so such a ticket is never Failed-flipped here.

function workerOutcomeFor(artifacts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-floor-'));
  const ticketId = 'of01';
  const ticketPath = path.join(root, ticketId);
  const workingDir = path.join(root, 'not-a-repo');
  fs.mkdirSync(ticketPath, { recursive: true });
  fs.mkdirSync(workingDir);
  const ticketFile = path.join(ticketPath, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketFile, `---\nid: ${ticketId}\nstatus: In Progress\ncomplexity_tier: medium\norder: 1\n---\n# ${ticketId}\n`);
  for (const name of artifacts) fs.writeFileSync(path.join(ticketPath, name), 'artifact\n');
  try {
    const ctx = {
      args: { isReviewTicket: false }, ticketPath, sessionWorkingDir: workingDir,
      mutableState: { finalized: false, timedOut: false },
    };
    const { isSuccess } = evaluateWorkerOutcome({ ctx, logContent: 'x'.repeat(300), startTime: Date.now() });
    const sha = 'abc1234def5678abc1234def5678abc1234def56';
    persistWorkerOutcomeStatus({
      ticketId, sessionRoot: root, sessionWorkingDir: workingDir, isSuccess, flipSuppressed: false, completionCommitSha: sha,
    });
    const body = fs.readFileSync(ticketFile, 'utf-8');
    const field = (key) => body.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?$`, 'm'))?.[1].trim();
    return { isSuccess, status: field('status'), completionCommit: field('completion_commit'), sha };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a committed medium ticket holding only research_*.md still persists Done through the worker outcome', () => {
  const out = workerOutcomeFor(['research_2026-10-08.md']);
  assert.equal(out.isSuccess, true, 'the any-of artifact floor accepts one lifecycle artifact');
  assert.equal(out.status, 'Done');
  assert.equal(out.completionCommit, out.sha);
});

test('control: a ticket with no lifecycle artifact at all is still a failed worker outcome', () => {
  const out = workerOutcomeFor([]);
  assert.equal(out.isSuccess, false);
  assert.equal(out.status, 'Failed');
});
