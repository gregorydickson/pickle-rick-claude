// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_PREFIXES, hasLifecycleArtifact } from '../types/index.js';

test('ARTIFACT_PREFIXES: implementation set', () => {
    assert.deepEqual(
        [...ARTIFACT_PREFIXES.implementation].sort(),
        ['code_review', 'conformance', 'plan', 'research']
    );
});

test('ARTIFACT_PREFIXES: review set', () => {
    assert.deepEqual(
        [...ARTIFACT_PREFIXES.review].sort(),
        ['review_findings', 'review_scope', 'spec_conformance']
    );
});

// --- implementation role ---

test('hasLifecycleArtifact: implementation matches research_DATE.md', () => {
    assert.equal(hasLifecycleArtifact(['research_2026-04-18.md'], 'implementation'), true);
});

test('hasLifecycleArtifact: implementation matches plan_DATE.md', () => {
    assert.equal(hasLifecycleArtifact(['plan_2026-04-18.md'], 'implementation'), true);
});

test('hasLifecycleArtifact: implementation matches research_review.md', () => {
    assert.equal(hasLifecycleArtifact(['research_review.md'], 'implementation'), true);
});

test('hasLifecycleArtifact: implementation matches plan_review.md', () => {
    assert.equal(hasLifecycleArtifact(['plan_review.md'], 'implementation'), true);
});

test('hasLifecycleArtifact: implementation matches conformance_DATE.md', () => {
    assert.equal(hasLifecycleArtifact(['conformance_2026-04-18.md'], 'implementation'), true);
});

test('hasLifecycleArtifact: implementation matches code_review_DATE.md', () => {
    assert.equal(hasLifecycleArtifact(['code_review_2026-04-18.md'], 'implementation'), true);
});

// --- review role ---

test('hasLifecycleArtifact: review matches review_scope.md (exact)', () => {
    assert.equal(hasLifecycleArtifact(['review_scope.md'], 'review'), true);
});

test('hasLifecycleArtifact: review matches spec_conformance.md (exact)', () => {
    assert.equal(hasLifecycleArtifact(['spec_conformance.md'], 'review'), true);
});

test('hasLifecycleArtifact: review matches review_findings.md (exact)', () => {
    assert.equal(hasLifecycleArtifact(['review_findings.md'], 'review'), true);
});

// --- cross-role negatives ---

test('hasLifecycleArtifact: review artifacts do NOT match implementation role', () => {
    assert.equal(
        hasLifecycleArtifact(['review_scope.md', 'review_findings.md', 'spec_conformance.md'], 'implementation'),
        false
    );
});

test('hasLifecycleArtifact: implementation artifacts do NOT match review role', () => {
    assert.equal(
        hasLifecycleArtifact(['research_2026-04-18.md', 'plan_2026-04-18.md'], 'review'),
        false
    );
});

// --- ghost-ticket prevention cases ---

test('hasLifecycleArtifact: empty list → false (the ghost-ticket guard)', () => {
    assert.equal(hasLifecycleArtifact([], 'implementation'), false);
    assert.equal(hasLifecycleArtifact([], 'review'), false);
});

test('hasLifecycleArtifact: only unrelated files → false', () => {
    assert.equal(
        hasLifecycleArtifact(['worker_session_12345.log', 'rick_ticket_abc.md', 'README.md'], 'implementation'),
        false
    );
});

test('hasLifecycleArtifact: stale archive dirs should not match (starts with _retry_)', () => {
    assert.equal(
        hasLifecycleArtifact(['_retry_1712345678', 'worker_session_1.log'], 'implementation'),
        false
    );
});

test('hasLifecycleArtifact: prefix-adjacent names do NOT falsely match', () => {
    // "researchy_notes.md" starts with "research" but not "research_" — should not match
    assert.equal(hasLifecycleArtifact(['researchy_notes.md'], 'implementation'), false);
    assert.equal(hasLifecycleArtifact(['planning.md'], 'implementation'), false);
    assert.equal(hasLifecycleArtifact(['review_scoped.md'], 'review'), false);
});

test('hasLifecycleArtifact: mixed list with at least one match → true', () => {
    assert.equal(
        hasLifecycleArtifact(
            ['worker_session_1.log', 'README.md', 'research_2026-04-18.md', 'rick_ticket_x.md'],
            'implementation'
        ),
        true
    );
});
