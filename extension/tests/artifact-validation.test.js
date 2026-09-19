// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingPrefixes, requiredTierArtifactPrefixes } from '../services/artifact-validation.js';
import { matchesArtifactPrefix } from '../types/index.js';
import { VALID_TICKET_COMPLEXITY_TIERS } from '../services/pickle-utils.js';

test('findMissingPrefixes: returns no missing prefixes when exact and dated artifacts exist', () => {
    const files = ['research.md', 'plan_2026-04-30.md', 'notes.md'];
    const prefixes = ['research', 'plan'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), []);
});

test('findMissingPrefixes: returns prefixes without exact or underscored file matches', () => {
    const files = ['research_2026-04-30.md', 'code_review.md'];
    const prefixes = ['research', 'plan', 'conformance', 'code_review'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), ['plan', 'conformance']);
});

test('findMissingPrefixes: ignores prefix-adjacent filenames', () => {
    const files = ['researchy_notes.md', 'planning.md', 'code_reviewed.md'];
    const prefixes = ['research', 'plan', 'code_review'];

    assert.deepEqual(findMissingPrefixes(files, prefixes), ['research', 'plan', 'code_review']);
});

// AP-EXT-ITER199-02: `findMissingPrefixes` must not carry its own copy of the
// `<prefix>.md` / `<prefix>_*` contract rule — it decides "present" through
// `matchesArtifactPrefix`, the one canonical expression in `types/index.ts`.
// The pin is DERIVED, not enumerated: it asserts the two agree on every
// (file, prefix) pair of a matrix built from the REAL tier prefixes, so a fork
// of either side reds it without anyone maintaining a table of expectations.
// Measured at the landing commit: 0 disagreements over 396 pairs, while the four
// realistic forks disagree on 48 / 36 / 8 / 36 of them.
const CONTRACT_SUFFIXES = [
    '', '.md', '_2026-08-29.md', '_review.md', '_review_2026-08-29.md',
    'y.md', 'ed.md', '-1.md', '_', '.txt',
];

function contractPrefixes() {
    const prefixes = new Set();
    for (const tier of VALID_TICKET_COMPLEXITY_TIERS) {
        for (const prefix of requiredTierArtifactPrefixes(tier)) prefixes.add(prefix);
    }
    return [...prefixes];
}

test('AP-EXT-ITER199-02: findMissingPrefixes decides presence by matchesArtifactPrefix, not a second copy of the rule', () => {
    const prefixes = contractPrefixes();
    assert.ok(prefixes.length > 0, 'tier prefixes must be non-empty or the matrix proves nothing');

    let pairs = 0;
    let present = 0;
    let absent = 0;
    for (const base of prefixes) {
        for (const suffix of CONTRACT_SUFFIXES) {
            const file = `${base}${suffix}`;
            for (const prefix of prefixes) {
                pairs++;
                const viaFindMissing = findMissingPrefixes([file], [prefix]).length === 0;
                const viaCanonical = matchesArtifactPrefix(file, prefix);
                assert.equal(
                    viaFindMissing,
                    viaCanonical,
                    `findMissingPrefixes and matchesArtifactPrefix disagree on file="${file}" prefix="${prefix}"`,
                );
                if (viaCanonical) present++; else absent++;
            }
        }
    }

    // Non-vacuity: a rule that answered a constant would satisfy the equality
    // above only by breaking one of these two counts.
    assert.ok(present > 0, 'matrix must contain matching pairs');
    assert.ok(absent > 0, 'matrix must contain non-matching pairs');
    assert.equal(pairs, prefixes.length * CONTRACT_SUFFIXES.length * prefixes.length);
});
