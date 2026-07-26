// @tier: fast
// Regression guard for anatomy-park finding
// `extension-trapdoor-afcc-deep-pattern-shape-drift`.
//
// R-AFCC-DEEP-4A migrated mux-runner.ts off `hasCompletionCommit` /
// `autoFillCompletionCommit` onto `readEvidence` / `persistEvidence` (B-DURA T70
// then deleted the `hasCompletionCommit` shim entirely and collapsed EvidenceKind
// to `committed | absent`), but the
// R-WUWC SOFT-variant and R-CCRC-2 trap-door entries in extension/CLAUDE.md kept
// pointing their PATTERN_SHAPE replay anchors at the deleted `autoFillCompletionCommit(`
// symbol. A replay anchor that names a symbol absent from the file can never match,
// so the trap door's second line of defense silently dies. This test pins the two
// trap-door entries to the symbols that actually implement the invariant in the
// source — it fails if either the prose drifts back to the stale symbol OR the
// source loses the real auto-promotion wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const claudeMdPath = path.join(repoRoot, 'extension', 'CLAUDE.md');
const servicesClaudeMdPath = path.join(repoRoot, 'extension', 'src', 'services', 'CLAUDE.md');
const muxRunnerPath = path.join(repoRoot, 'extension', 'src', 'bin', 'mux-runner.ts');

const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
const servicesClaudeMd = fs.readFileSync(servicesClaudeMdPath, 'utf8');
const muxRunner = fs.readFileSync(muxRunnerPath, 'utf8');

/** Pull a single trap-door bullet (one `- ...` line) by a unique substring. */
function trapDoorEntry(needle, source = claudeMd, label = 'extension/CLAUDE.md') {
  const line = source
    .split('\n')
    .find((l) => l.trimStart().startsWith('- ') && l.includes(needle));
  assert.ok(line, `trap-door entry containing "${needle}" not found in ${label}`);
  return line;
}

test('R-WUWC SOFT-variant trap door names the live persistEvidence anchor, not the migrated-away autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-WUWC SOFT-variant auto-promote');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-WUWC trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('persistEvidence('),
    'R-WUWC trap door must reference the current persistEvidence( auto-promotion call',
  );
  assert.ok(
    entry.includes("committed"),
    'R-WUWC trap door must reference the current committed evidence kind (B-DURA T70 collapse)',
  );
});

test('R-CCRC-2 trap door names the inline upsertFrontmatterField anchor, not autoFillCompletionCommit', () => {
  const entry = trapDoorEntry('R-CCRC-2 done-flip guard routing');
  assert.ok(
    !entry.includes('autoFillCompletionCommit'),
    'R-CCRC-2 trap door still references the R-AFCC-DEEP-4A-removed autoFillCompletionCommit symbol',
  );
  assert.ok(
    entry.includes('upsertFrontmatterField('),
    'R-CCRC-2 trap door must reference the inline upsertFrontmatterField( completion_commit persist',
  );
});

test('R-CCQF trap door names the live readEvidence anchor, not the deprecated hasCompletionCommit shim', () => {
  const entry = trapDoorEntry('R-CCQF quoted-form completion_commit parser');
  assert.ok(
    entry.includes('ticket-completion-evidence.ts'),
    'R-CCQF trap door must anchor to ticket-completion-evidence.ts (readEvidence), not the deprecated pickle-utils hasCompletionCommit shim',
  );
  assert.ok(
    !entry.includes('inside `hasCompletionCommit`'),
    'R-CCQF PATTERN_SHAPE still anchors its replay marker inside the deprecated hasCompletionCommit shim',
  );
});

test('R-CCRC-1 trap door is marked RETIRED and no longer claims a live r_code fallback', () => {
  const entry = trapDoorEntry('R-CCRC-1');
  assert.ok(
    entry.includes('RETIRED'),
    'R-CCRC-1 trap door must be marked RETIRED — the r_code/ref-token fallback it pinned was deleted by B-GITATTR WS-3',
  );
  assert.ok(
    !entry.includes("readFrontmatterField(content, 'r_code')"),
    'R-CCRC-1 trap door must not claim readEvidence still reads r_code — that fallback is gone',
  );
});

test('R-RIC-EXPLICIT trap door names the live readEvidence anchor in ticket-completion-evidence.ts, not the deprecated pickle-utils hasCompletionCommit shim', () => {
  // R-RIC-EXPLICIT lives in src/services/CLAUDE.md, not the top-level extension/CLAUDE.md.
  const entry = trapDoorEntry(
    'R-RIC-EXPLICIT',
    servicesClaudeMd,
    'extension/src/services/CLAUDE.md',
  );
  assert.ok(
    entry.includes('ticket-completion-evidence.ts'),
    'R-RIC-EXPLICIT trap door must anchor to ticket-completion-evidence.ts (readEvidence), not the deprecated pickle-utils hasCompletionCommit shim',
  );
  assert.ok(
    entry.includes('readEvidence'),
    'R-RIC-EXPLICIT trap door must reference readEvidence (the live explicit-source home)',
  );
  assert.ok(
    !/`hasCompletionCommit` MUST honor/.test(entry),
    'R-RIC-EXPLICIT INVARIANT still anchors explicit-source honoring to the deprecated hasCompletionCommit shim',
  );
  assert.ok(
    !/PATTERN_SHAPE: `readFrontmatterField` call against/.test(entry),
    'R-RIC-EXPLICIT PATTERN_SHAPE still uses the pre-migration grep-on-message-body anchor',
  );
});

test('ticket-completion-evidence.ts implements the R-CCQF/R-RIC-EXPLICIT invariants the trap doors point at (post R-AFCC-DEEP-4A)', () => {
  const evidenceSrc = fs.readFileSync(
    path.join(repoRoot, 'extension', 'src', 'services', 'ticket-completion-evidence.ts'),
    'utf8',
  );
  for (const symbol of [
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit')",
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred')",
    'export function readEvidence',
  ]) {
    assert.ok(
      evidenceSrc.includes(symbol),
      `ticket-completion-evidence.ts missing R-CCQF anchor: ${symbol}`,
    );
  }
  // B-GITATTR WS-3: the r_code ref-token scan fallback (R-CCRC-1) is deleted — readEvidence's
  // scan is trailer-only now. `readFrontmatterField(content, 'r_code')` legitimately
  // SURVIVES inside isForeignAttributedExplicitSha's own-attribution check (R-OMA/R-PDUP),
  // so the extractRCodeTokens symbol is the precise anchor for the deleted scan fallback.
  assert.ok(
    !evidenceSrc.includes('extractRCodeTokens'),
    'R-CCRC-1 extractRCodeTokens ref-token helper must stay deleted (B-GITATTR WS-3)',
  );
  // R-RIC-EXPLICIT: the explicit completion_commit field MUST be honored before
  // the git-log scan. Pin the source ordering so the explicit branch can never
  // silently regress below scanGitLog (which would re-open the MASTER_PLAN #83 fatal).
  const explicitIdx = evidenceSrc.indexOf(
    "normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit')",
  );
  const scanIdx = evidenceSrc.indexOf('scanGitLog({');
  assert.ok(explicitIdx !== -1 && scanIdx !== -1, 'readEvidence missing explicit-source or scanGitLog anchors');
  assert.ok(
    explicitIdx < scanIdx,
    'R-RIC-EXPLICIT: explicit completion_commit read must precede scanGitLog in readEvidence',
  );
  // B-DURA T70 deleted the deprecated hasCompletionCommit shim — pickle-utils.ts
  // must NOT re-grow it (the single oracle is readEvidence).
  const pickleUtils = fs.readFileSync(
    path.join(repoRoot, 'extension', 'src', 'services', 'pickle-utils.ts'),
    'utf8',
  );
  assert.ok(
    !/export function hasCompletionCommit\b/.test(pickleUtils),
    'hasCompletionCommit shim must stay deleted (B-DURA T70); readEvidence is the sole oracle',
  );
});

test('mux-runner.ts implements completion-evidence auto-promotion via persistEvidence/upsertFrontmatterField (post R-AFCC-DEEP-4A)', () => {
  // The migrated-away symbol must be gone from THIS file (it legitimately still
  // lives in spawn-morty.ts / auto-fill-completion-commit.ts).
  assert.ok(
    !muxRunner.includes('autoFillCompletionCommit'),
    'mux-runner.ts unexpectedly references autoFillCompletionCommit — trap doors assume it was migrated out',
  );
  // The live anchors the trap-door PATTERN_SHAPEs now point at must be present.
  for (const symbol of [
    'persistEvidence(',
    'upsertFrontmatterField(',
    'guardCompletionCommitBeforeDone',
    'clearStaleDoneWithoutCommitEvidence',
    'markTicketDone',
    "'committed'",
  ]) {
    assert.ok(
      muxRunner.includes(symbol),
      `mux-runner.ts missing trap-door PATTERN_SHAPE anchor: ${symbol}`,
    );
  }
});
