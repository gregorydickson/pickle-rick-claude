/**
 * R-AFCC-DEEP-4A: Unified ticket completion-evidence module.
 *
 * Single conceptual entity for "is this ticket attributably done?".
 * Supersedes the divergent invariants that were once split across the legacy
 * completion-commit helpers, the inlined guardCompletionCommitBeforeDone upsert,
 * and the collapsed phantom-done batch loop.
 *
 * B-DURA T70: with the durable iteration-boundary commit (T10) always present and
 * one Done-flip oracle reading it, the multi-kind evidence grammar is dead surface.
 * EvidenceKind is collapsed to the two states that drive a decision —
 * `committed` (an attributable git commit exists: explicit field, inferred field,
 * or git-log scan, all git-verified) and `absent` (no usable evidence).
 *
 * R-AFCC-STAGE: non-repo workingDir is a legitimate state, NOT an exception — a
 * stored-but-currently-unverifiable SHA simply reads `absent` (no usable evidence
 * the gate can act on) rather than carrying a distinct stale variant.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readFrontmatterField,
  upsertFrontmatterField,
  normalizeCompletionCommitField,
  ticketFilePath,
} from './pickle-utils.js';
import { readDeclaredFiles } from './ticket-declared-files.js';
import type { GateVerdict } from '../lib/salvage-ticket.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 2-state completion-evidence kind (B-DURA T70 collapse).
 *
 * committed — an attributable git commit exists and is git-reachable: the
 *             completion_commit field (reachable), the completion_commit_inferred
 *             field (git-verified), or a git-log scan hit. Carries the SHA.
 * absent    — no usable evidence the gate can act on: no field/scan match, an
 *             explicit SHA that is not git-reachable, a baseline SHA (R-CXOR-2),
 *             or a stored-but-currently-unverifiable inferred SHA (R-AFCC-STAGE).
 */
export type EvidenceKind = 'committed' | 'absent';

/** Attribution source for a `committed` EvidenceResult. */
export type EvidenceVia = 'explicit' | 'inferred' | 'scan';

/**
 * B-1SEAM/R-AICF: refusal detail for an `absent` EvidenceResult so decision
 * sites (evaluateCompletionEvidence) can report WHY evidence was refused.
 *   no_evidence                          — no field/scan match at all.
 *   baseline_sha                         — explicit sha equals a session baseline (R-CXOR-2, hard-absent).
 *   unreachable_explicit_unattributable  — explicit sha unreachable AND the inferred/scan
 *                                          fallback branches found nothing (R-AICF).
 *   foreign_attribution                  — explicit sha positively attributed to a
 *                                          DIFFERENT ticket (R-OMA, hard-absent).
 */
export type EvidenceAbsentReason =
  | 'no_evidence'
  | 'baseline_sha'
  | 'unreachable_explicit_unattributable'
  | 'foreign_attribution';

export interface EvidenceResult {
  kind: EvidenceKind;
  sha?: string;
  /** Attribution source when kind === 'committed'. */
  via?: EvidenceVia;
  /** Refusal detail when kind === 'absent'. */
  absentReason?: EvidenceAbsentReason;
  /** R-CCR-1: true when per-ticket workingDir was unusable and fallbackDir succeeded. */
  usedFallback?: boolean;
}

/** Context needed to locate and probe a ticket's completion evidence. */
export interface EvidenceCtx {
  /** Session root directory. Used to derive ticketPath when ticketPath is absent. */
  sessionDir?: string;
  /** Short ticket hash. Used to derive ticketPath when ticketPath is absent. */
  ticketId?: string;
  /** Absolute path to the rick_ticket_<id>.md file; overrides sessionDir+ticketId. */
  ticketPath?: string;
  /** Working directory for git probe operations. */
  workingDir: string;
  /** Optional epoch for filtering git-log commits before session start. */
  startTimeEpoch?: number | null;
  /** R-CCR-1: fallback directory when workingDir is unusable for git. */
  fallbackDir?: string;
  /** R-CXOR-2: baseline commit SHA at session start — rejected as completion evidence. */
  startCommit?: string | null;
  /** R-CXOR-2: pinned SHA at session bootstrap — rejected as completion evidence. */
  pinnedSha?: string | null;
  /**
   * R-PDUP sanctioned twin-borrow: extra ticket ids/r_codes treated as OWN
   * attribution by the R-OMA foreign-attribution check. The split-original
   * auto-close borrows a twin's delivering commit whose message word-boundary
   * names the TWIN (a sibling dir of the original); injecting the twin ids here
   * keeps that sanctioned borrow from reading as `foreign_attribution`.
   * Empty/absent → default R-OMA behavior.
   */
  ownAttributionTokens?: string[];
  /**
   * R-CECB: greenness oracle for the declared-file-touch branch-attribution path.
   * Reuses the salvage `GateVerdict` contract (`salvage-ticket.ts`); production
   * callers wire it to the real working-tree fast-test gate
   * (`runBetweenTicketFastTests`). Lazily invoked only when a declared-file-touch
   * candidate is found, so the common no-candidate scan path costs nothing. Absent
   * → the conservative built-in default treats the tree as not-green.
   */
  greenGate?: () => GateVerdict;
}

/** Options for persistEvidence. */
export interface PersistOpts {
  /**
   * 'best-effort': write the frontmatter field; attempt git-stage but swallow
   *   failure (non-repo workingDir is a legitimate state per R-AFCC-STAGE).
   * 'required': write the frontmatter field; throw if git-stage fails.
   */
  stage: 'best-effort' | 'required';
}

export interface PersistResult {
  action: 'written' | 'already_present' | 'no_file' | 'unwritable';
  sha?: string;
  /** True when git-stage succeeded; false when it failed (best-effort only). */
  staged?: boolean;
}

/** Policy for gateForPhantomDoneRevert. */
export interface RevertPolicy {
  /** Persisted state flags (reserved; no flag currently gates revert policy). */
  flags?: Record<string, unknown> | null;
}

export type RevertDecision = {
  action: 'keep' | 'revert';
  kind: EvidenceKind;
  sha?: string;
  fallbackFired?: boolean;
};

// ---------------------------------------------------------------------------
// Private helpers (inlined from pickle-utils private scope)
// ---------------------------------------------------------------------------

function resolveTicketPath(ctx: Pick<EvidenceCtx, 'sessionDir' | 'ticketId' | 'ticketPath'>): string | null {
  if (typeof ctx.ticketPath === 'string' && ctx.ticketPath.length > 0) return ctx.ticketPath;
  if (
    typeof ctx.sessionDir === 'string' && ctx.sessionDir.length > 0 &&
    typeof ctx.ticketId === 'string' && ctx.ticketId.length > 0
  ) {
    return ticketFilePath(ctx.sessionDir, ctx.ticketId);
  }
  return null;
}

/**
 * 3-way git cat-file probe (R-AFCC-DEEP-3C pattern).
 * Returns 'exists' (exit 0), 'not-exists' (exit 1), or 'git-could-not-run'
 * (exit 128, ENOENT, ETIMEDOUT, SIGTERM — git produced no definitive answer).
 */
function probeCatFile(workingDir: string, sha: string): 'exists' | 'not-exists' | 'git-could-not-run' {
  try {
    execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'exists';
  } catch (err) {
    const e = err as { status?: number | null; code?: string; signal?: string | null };
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' || e.status === 128 || e.code === 'ENOENT') {
      return 'git-could-not-run';
    }
    return 'not-exists';
  }
}

/** Boolean commit-reachability check; false for both "not found" and "git error". */
function commitExists(workingDir: string, sha: string): boolean {
  return probeCatFile(workingDir, sha) === 'exists';
}

function extractRCodeTokens(title: string | null): string[] {
  if (!title) return [];
  return [...new Set(Array.from(title.matchAll(/\bR-[A-Z0-9-]+\b/gi), m => m[0].toLowerCase()))];
}

function readFirstHeading(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() || null;
}

/** R-CXOR-2: true when sha is a session baseline (start_commit or pinned_sha). */
function isBaselineSha(sha: string, ctx: Pick<EvidenceCtx, 'startCommit' | 'pinnedSha'>): boolean {
  return (ctx.startCommit != null && sha === ctx.startCommit) ||
    (ctx.pinnedSha != null && sha === ctx.pinnedSha);
}

/**
 * Probes whether an explicit SHA is git-reachable, falling back to fallbackDir on
 * 'git-could-not-run'. Returns the EvidenceResult on success, or null when the
 * SHA is not reachable (caller maps null → absent).
 */
function probeExplicitSha(sha: string, workingDir: string, fallbackDir?: string): EvidenceResult | null {
  const primary = probeCatFile(workingDir, sha);
  if (primary === 'exists') return { kind: 'committed', sha };
  if (primary !== 'git-could-not-run') return null;
  if (!fallbackDir || fallbackDir === workingDir) return null;
  if (probeCatFile(fallbackDir, sha) === 'exists') return { kind: 'committed', sha, usedFallback: true };
  return null;
}

type GitLogEntry = { sha: string; epoch: number; message: string };

function parseGitLog(raw: string): GitLogEntry[] {
  return raw
    .split('\n---pickle-commit-boundary---\n')
    .map(e => e.trim())
    .filter(Boolean)
    .map(e => {
      const [sha = '', epochRaw = '0', ...parts] = e.split('\n');
      return { sha: sha.trim(), epoch: Number(epochRaw.trim()) || 0, message: parts.join('\n').trim() };
    })
    .filter(e => /^[0-9a-f]{40}$/i.test(e.sha));
}

/**
 * R-CECB: the files a commit touched, via `git show --name-only`. Best-effort —
 * any git failure yields `[]` (commit not attributable by file-touch).
 */
function commitTouchedFiles(workingDir: string, sha: string): string[] {
  try {
    const raw = execFileSync(
      'git',
      ['-C', workingDir, 'show', '--name-only', '--format=', sha],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return raw.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * True when a git-tracked path in `touched` matches a declared path. `declared`
 * is already `./`-normalized by `readDeclaredFiles`; `git show --name-only` emits
 * repo-relative paths with no `./` prefix, so an exact set membership suffices.
 */
function touchesDeclared(touched: string[], declared: string[]): boolean {
  if (declared.length === 0) return false;
  const set = new Set(declared);
  return touched.some(t => set.has(t));
}

/**
 * Commit subject+body for `sha`, via `git show -s --format=%B`. Best-effort —
 * any git failure yields `''`. Lowercased by the caller's matcher.
 */
function commitMessage(workingDir: string, sha: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', workingDir, 'show', '-s', '--format=%B', sha],
      { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * R-OMA: every OTHER ticket id (directory basename) under `sessionDir`,
 * lowercased, excluding `selfTicketId`. Best-effort → `[]`. Reused to detect a
 * commit whose subject positively names a DIFFERENT ticket (foreign attribution).
 *
 * R-OMASD: a session root also holds NON-ticket directories (`gate`, `archive`,
 * `refinement`, `microverse_*`, and anatomy-park subsystem dirs like `bin` /
 * `extension`). Those basenames are ordinary English words that word-boundary-match
 * routine commit subjects, so admitting them manufactures foreign attribution
 * against a ticket's OWN commit. A ticket dir is identified the same way
 * `enumerateSiblingDeclaredFiles` identifies one: it holds a `rick_ticket_*.md`.
 */
function enumerateSiblingTicketIds(sessionDir: string, selfTicketId: string | null): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const selfLower = selfTicketId ? selfTicketId.toLowerCase() : null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name.toLowerCase();
    if (selfLower && id === selfLower) continue;
    if (!isTicketDir(path.join(sessionDir, entry.name))) continue;
    out.push(id);
  }
  return out;
}

/** True iff `dir` holds a `rick_ticket_<hash>.md` artifact (i.e. it is a ticket dir). */
function isTicketDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(f => f.startsWith('rick_ticket_') && f.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * R-OMA (LOA-1588): true iff the explicit-completion-commit `sha` is POSITIVELY
 * attributed to a DIFFERENT ticket — its commit subject/body word-boundary-matches
 * a sibling ticket id (e.g. a no-op/clean-audit ticket borrowing another ticket's
 * e2e commit hash) WITHOUT also naming THIS ticket's own id/r_code.
 *
 * REJECTION-BY-POSITIVE-FOREIGN-ATTRIBUTION ONLY: default is accept. Absence of a
 * matching message is NEVER grounds for rejection (R-RIC-EXPLICIT / explicit-SHA-wins);
 * a generic or own-ticket message returns false (accept). Reuses the same
 * word-boundary matcher shape as `scanGitLogByRefToken`.
 */
function isForeignAttributedExplicitSha(
  sha: string,
  ctx: Pick<EvidenceCtx, 'workingDir' | 'sessionDir' | 'ticketId' | 'ownAttributionTokens'>,
  content: string,
): boolean {
  if (!ctx.sessionDir) return false;
  const selfId = readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null;
  const siblingIds = enumerateSiblingTicketIds(ctx.sessionDir, selfId);
  if (siblingIds.length === 0) return false;
  const message = commitMessage(ctx.workingDir, sha).toLowerCase();
  if (!message) return false;
  const wordBoundary = (token: string): RegExp =>
    new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  // Own attribution wins: never reject a commit that names this ticket's id/r_code.
  // R-PDUP: sanctioned twin-borrow tokens count as own attribution too.
  const selfRCode = readFrontmatterField(content, 'r_code');
  const ownTokens = [
    ...(selfId ? [selfId.toLowerCase()] : []),
    ...(selfRCode ? [selfRCode.trim().toLowerCase()] : []),
    ...(ctx.ownAttributionTokens ?? []).map(t => t.trim().toLowerCase()),
  ].filter(Boolean);
  if (ownTokens.some(t => wordBoundary(t).test(message))) return false;
  // Foreign positive: the message names a DIFFERENT ticket id.
  return siblingIds.some(id => wordBoundary(id).test(message));
}

/**
 * R-CECB: declared in-scope files for every OTHER ticket under `sessionDir`,
 * read directly via `fs` (inlined dir walk; importing `collectTickets` from
 * pickle-utils would create an import cycle — pickle-utils imports this module).
 * Best-effort → `[]`.
 */
function enumerateSiblingDeclaredFiles(
  sessionDir: string,
  selfTicketId: string | null,
): Array<{ ticketId: string; files: string[] }> {
  const out: Array<{ ticketId: string; files: string[] }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (selfTicketId && entry.name === selfTicketId) continue;
    const subDir = path.join(sessionDir, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(subDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith('rick_ticket_') || !file.endsWith('.md')) continue;
      try {
        const content = fs.readFileSync(path.join(subDir, file), 'utf8');
        const declared = readDeclaredFiles(content);
        if (declared.length > 0) out.push({ ticketId: entry.name, files: declared });
      } catch {
        /* skip unreadable sibling */
      }
    }
  }
  return out;
}

/**
 * R-CECB: declared-file-touch attribution. A post-startTimeEpoch commit attributes
 * to the ticket iff it touches ≥1 declared in-scope file AND it is green. Ref
 * tokens (id/r_code) are CORROBORATING via the existing scan, never required here.
 * Ambiguity (the commit also touches a DIFFERENT ticket's declared files) →
 * attribute to NEITHER. Newest green wins (entries iterate newest-first).
 */
function scanGitLogByFileTouch(
  entries: GitLogEntry[],
  args: {
    workingDir: string;
    startTimeEpoch?: number | null;
    declaredFiles: string[];
    siblingDeclared: Array<{ ticketId: string; files: string[] }>;
    greenGate: () => GateVerdict;
  },
): { sha: string } | null {
  const startEpoch = Number(args.startTimeEpoch);
  for (const e of entries) {
    if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch) continue;
    const touched = commitTouchedFiles(args.workingDir, e.sha);
    if (!touchesDeclared(touched, args.declaredFiles)) continue;
    // Ambiguity: a DIFFERENT ticket also declares one of the touched files.
    const ambiguous = args.siblingDeclared.some(s => touchesDeclared(touched, s.files));
    if (ambiguous) continue;
    // Greenness — reuse the salvage GateVerdict oracle (lazy).
    if (args.greenGate() !== 'passing') continue;
    return { sha: e.sha };
  }
  return null;
}

function scanGitLog(args: {
  workingDir: string;
  ticketId: string | null;
  title: string | null;
  startTimeEpoch?: number | null;
  ticketPath?: string | null;
  rCode?: string | null;
  declaredFiles?: string[];
  siblingDeclared?: Array<{ ticketId: string; files: string[] }>;
  greenGate?: () => GateVerdict;
}): { sha: string } | null {
  const matchers = [
    ...(args.ticketId ? [args.ticketId.toLowerCase()] : []),
    ...extractRCodeTokens(args.title),
  ];
  const rCodeRe: RegExp | null = (() => {
    if (!args.rCode) return null;
    const code = args.rCode.trim().toLowerCase();
    if (!code) return null;
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`);
  })();
  const declaredFiles = args.declaredFiles ?? [];
  // No id/r_code matcher AND no declared-file-touch path → nothing to scan.
  if (matchers.length === 0 && !rCodeRe && declaredFiles.length === 0) return null;

  const commands: string[][] = [];
  if (args.ticketPath) {
    commands.push(['-C', args.workingDir, 'log', '-n', '20', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', '--', args.ticketPath]);
  }
  commands.push(['-C', args.workingDir, 'log', '-n', '50', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', 'HEAD']);

  // Pass 1: ref-token scan (word-boundary ticket-id + word-boundary r_code).
  // B-DURA T70 narrows the prior R-CCRC fuzzy substring widening to a
  // word-boundary match so an unrelated commit mentioning the hash inside a
  // longer token can no longer false-attribute. Highest-precedence match;
  // caches the HEAD pass entries for the Pass-2 file-touch fallback.
  const headEntries: GitLogEntry[] = [];
  const refHit = scanGitLogByRefToken(commands, {
    workingDir: args.workingDir,
    matchers,
    rCodeRe,
    startTimeEpoch: args.startTimeEpoch,
    headEntriesOut: headEntries,
  });
  if (refHit) return refHit;

  // Pass 2 (R-CECB): declared-file-touch attribution — file-touch primary, ref
  // token corroborating (already tried above), greenness via the salvage gate,
  // ambiguity → neither, newest green wins. Only when the ticket declares files.
  if (declaredFiles.length > 0 && headEntries.length > 0) {
    return scanGitLogByFileTouch(headEntries, {
      workingDir: args.workingDir,
      startTimeEpoch: args.startTimeEpoch,
      declaredFiles,
      siblingDeclared: args.siblingDeclared ?? [],
      greenGate: args.greenGate ?? (() => 'errored' as GateVerdict),
    });
  }
  return null;
}

/**
 * Pass 1 of the git-log scan: ref-token attribution (word-boundary ticket-id +
 * word-boundary r_code). B-DURA T70 narrowed the ticket-id match from a
 * substring scan to a word-boundary scan. Captures the HEAD-pass entries into
 * `headEntriesOut` so the caller can reuse them for the file-touch fallback.
 */
function scanGitLogByRefToken(
  commands: string[][],
  args: {
    workingDir: string;
    matchers: string[];
    rCodeRe: RegExp | null;
    startTimeEpoch?: number | null;
    headEntriesOut: GitLogEntry[];
  },
): { sha: string } | null {
  const startEpoch = Number(args.startTimeEpoch);
  const lastCmd = commands[commands.length - 1];
  // B-DURA T70: word-boundary matchers (was substring `includes`). Tokens are
  // already lowercased; escape regex metacharacters before anchoring with \b.
  const matcherRes = args.matchers.map(
    t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  );
  const checkEntry = (e: GitLogEntry): { sha: string } | null => {
    if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch) return null;
    const lower = e.message.toLowerCase();
    if (matcherRes.some(re => re.test(lower))) return { sha: e.sha };
    if (args.rCodeRe && args.rCodeRe.test(lower)) return { sha: e.sha };
    return null;
  };
  for (const gitArgs of commands) {
    let parsed: GitLogEntry[];
    try {
      const raw = execFileSync('git', gitArgs, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      parsed = parseGitLog(raw);
    } catch {
      continue;
    }
    if (gitArgs === lastCmd) args.headEntriesOut.push(...parsed);
    for (const entry of parsed) {
      const matched = checkEntry(entry);
      if (matched) return matched;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point 1: readEvidence
// ---------------------------------------------------------------------------

/**
 * Reads completion evidence for a ticket and returns a 2-state EvidenceKind
 * (B-DURA T70):
 *   - committed: explicit completion_commit (git-reachable), git-verified
 *     completion_commit_inferred field, or a git-log scan hit.
 *   - absent: no field/scan match, an explicit SHA that is not git-reachable, a
 *     baseline SHA (R-CXOR-2), or a stored-but-unverifiable inferred SHA.
 */
export function readEvidence(ctx: EvidenceCtx): EvidenceResult {
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return { kind: 'absent' };

  let content: string;
  try {
    content = fs.readFileSync(tPath, 'utf8');
  } catch {
    return { kind: 'absent' };
  }

  // --- Explicit completion_commit field ---
  const explicit = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit'));
  let unreachableExplicit = false;
  if (explicit) {
    // R-CXOR-2: reject baseline SHAs — a ticket whose only "commit" is the session
    // start_commit or pinned_sha did no real work; treat it as absent evidence.
    if (isBaselineSha(explicit, ctx)) {
      process.stderr.write(
        `[ticket-completion-evidence] baseline sha ${explicit} rejected as completion evidence — ticket did no work beyond session start\n`,
      );
      return { kind: 'absent', absentReason: 'baseline_sha' };
    }
    const r = probeExplicitSha(explicit, ctx.workingDir, ctx.fallbackDir);
    // R-OMA: reject a reachable explicit SHA ONLY when it is positively attributed
    // to a DIFFERENT ticket (a no-op/clean-audit ticket borrowing another ticket's
    // commit hash). Default = accept (explicit-SHA-wins).
    if (r && isForeignAttributedExplicitSha(explicit, ctx, content)) {
      process.stderr.write(
        `[ticket-completion-evidence] explicit sha ${explicit} rejected — positively attributed to a different ticket (R-OMA foreign-attribution)\n`,
      );
      return { kind: 'absent', absentReason: 'foreign_attribution' };
    }
    if (r) return { ...r, via: 'explicit' };
    // R-AICF: explicit SHA present but UNREACHABLE (hallucinated/dropped stamp).
    // No longer hard-absent — fall through to the inferred-field and git-log-scan
    // branches so real untagged work is still attributable. Baseline-rejected and
    // foreign-attributed explicit SHAs above stay hard-absent.
    unreachableExplicit = true;
    process.stderr.write(
      `[ticket-completion-evidence] explicit sha ${explicit} unreachable — falling through to inferred/scan attribution (R-AICF)\n`,
    );
  }
  const absent = (): EvidenceResult => ({
    kind: 'absent',
    absentReason: unreachableExplicit ? 'unreachable_explicit_unattributable' : 'no_evidence',
  });

  // --- Inferred field (completion_commit_inferred) ---
  const inferredField = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred'));
  if (inferredField) {
    if (commitExists(ctx.workingDir, inferredField)) {
      return { kind: 'committed', sha: inferredField, via: 'inferred' };
    }
    // R-AFCC-STAGE: field present but git can't verify (non-repo workingDir or a
    // dropped commit). A stored-but-unverifiable SHA is not evidence the gate can
    // act on → absent. Short-circuit (the scan would fail for the same reason).
    return absent();
  }

  // --- Git log scan (ref token + R-CECB declared-file-touch) ---
  const selfId = readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null;
  const declaredFiles = readDeclaredFiles(content);
  const scan = scanGitLog({
    workingDir: ctx.workingDir,
    ticketId: selfId,
    title: readFrontmatterField(content, 'title') ?? readFirstHeading(content),
    startTimeEpoch: ctx.startTimeEpoch,
    ticketPath: tPath,
    rCode: readFrontmatterField(content, 'r_code'),
    declaredFiles,
    siblingDeclared: ctx.sessionDir ? enumerateSiblingDeclaredFiles(ctx.sessionDir, selfId) : [],
    greenGate: ctx.greenGate,
  });
  if (scan) return { kind: 'committed', sha: scan.sha, via: 'scan' };

  return absent();
}

// ---------------------------------------------------------------------------
// Entry point 2: persistEvidence
// ---------------------------------------------------------------------------

/**
 * Writes sha into the ticket's completion_commit frontmatter field and
 * optionally git-stages the file.
 *
 * R-AFCC-STAGE: stage:'best-effort' means git-staging failure is non-fatal.
 * A non-repo workingDir is a legitimate state and MUST NOT throw.
 */
export function persistEvidence(ctx: EvidenceCtx, sha: string, opts: PersistOpts): PersistResult {
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return { action: 'no_file' };

  let content: string;
  try {
    content = fs.readFileSync(tPath, 'utf8');
  } catch {
    return { action: 'no_file' };
  }

  if (readFrontmatterField(content, 'completion_commit')) {
    return { action: 'already_present', sha: readFrontmatterField(content, 'completion_commit') ?? sha };
  }

  const updated = upsertFrontmatterField(content, 'completion_commit', sha);
  if (!updated) return { action: 'unwritable' };

  try {
    fs.writeFileSync(tPath, updated);
  } catch {
    return { action: 'unwritable' };
  }

  // Git-stage
  let staged = false;
  try {
    execFileSync('git', ['-C', ctx.workingDir, 'add', '--', tPath], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    staged = true;
  } catch {
    if (opts.stage === 'required') throw new Error(`persistEvidence: git add failed for ${tPath}`);
    // best-effort: staged stays false
  }

  return { action: 'written', sha, staged };
}

// ---------------------------------------------------------------------------
// Entry point 3: evaluateCompletionEvidence — the ONE completion predicate
// ---------------------------------------------------------------------------

/** Decision site invoking the predicate; only 'done-flip' consults the worker-gate verdict. */
export type CompletionDecisionKind = 'done-flip' | 'phantom-watch' | 'attribution';

/**
 * B-1SEAM WS-1: context for the ONE completion predicate. Extends EvidenceCtx
 * with REQUIRED (nullable but explicit) baseline SHAs — a compile-time pin so
 * no decision site can silently omit R-CXOR-2 baseline rejection — plus the
 * decision kind and injected capability providers (mux-runner owns the real
 * worker-gate verdict resolver and announcement reader; they arrive as deps so
 * this module stays the policy home without importing runner internals).
 */
export interface CompletionDecisionCtx extends EvidenceCtx {
  /** R-CXOR-2: session start_commit — REQUIRED wiring, null when genuinely unknown. */
  startCommit: string | null;
  /** R-CXOR-2: session pinned_sha — REQUIRED wiring, null when genuinely unknown. */
  pinnedSha: string | null;
  decision: CompletionDecisionKind;
  /**
   * R-CWGE: worker-gate verdict resolver, consulted ONLY when decision === 'done-flip'.
   * Fail-closed: a red or absent/unavailable verdict refuses the Done-flip; an
   * UN-injected resolver on a done-flip also refuses (worker_gate_unavailable).
   */
  workerGateVerdict?: () => { verdict: 'green' | 'red' | 'absent'; computedVia: string };
  /** R-CCEM: the worker's own announced completion SHA (state.activity), or null. */
  announcedSha?: () => string | null;
  /** R-CCGR: backoff (ms) before the single absent re-read; defaults to the env-clamped 500ms. */
  rereadBackoffMs?: number;
}

export type CompletionDecisionRefusalReason =
  | EvidenceAbsentReason
  | 'worker_gate_red'
  | 'worker_gate_unavailable';

export type CompletionDecision =
  | { ok: true; sha: string; via: EvidenceVia | 'announcement'; usedFallback?: boolean }
  | {
      ok: false;
      reason: CompletionDecisionRefusalReason;
      /** Present on worker-gate refusals so callers can log/emit verdict detail. */
      gate?: { verdict: 'green' | 'red' | 'absent'; computedVia: string };
    };

/**
 * R-CCGR: a process-blocking sleep for the single backoff re-read.
 * `Atomics.wait` blocks without spawning a child process.
 */
function sleepSyncMs(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SharedArrayBuffer disabled — skip the backoff */ }
}

/** R-CCGR backoff before the single re-read; env-overridable, clamped. */
function defaultRereadBackoffMs(): number {
  const raw = Number(process.env.PICKLE_GUARD_REREAD_BACKOFF_MS);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, 5000);
  return 500;
}

/**
 * R-CCEM: absent evidence + a worker-announced commit SHA → persist the worker's
 * OWN declared SHA as `completion_commit_inferred` and re-probe (absorbs
 * mux-runner's recoverInferredFromAnnouncement). `readEvidence` still gates on
 * commitExists + baseline rejection, so a non-existent or baseline SHA stays
 * absent. Best-effort; never overwrites an explicit `completion_commit`.
 */
function recoverFromAnnouncement(ctx: CompletionDecisionCtx): EvidenceResult | null {
  if (!ctx.announcedSha) return null;
  let announced: string | null;
  try {
    announced = ctx.announcedSha();
  } catch {
    return null;
  }
  if (!announced) return null;
  const tPath = resolveTicketPath(ctx);
  if (!tPath) return null;
  try {
    const raw = fs.readFileSync(tPath, 'utf8');
    if (!readFrontmatterField(raw, 'completion_commit')) {
      const upd = upsertFrontmatterField(raw, 'completion_commit_inferred', announced);
      if (upd) {
        fs.writeFileSync(tPath, upd);
        return readEvidence(ctx);
      }
    }
  } catch { /* best-effort — fall through to existing classification */ }
  return null;
}

/**
 * B-1SEAM WS-1: the ONE completion predicate — the single policy answering
 * "may this ticket's completion evidence be acted on?". Policy is the shipped
 * `guardCompletionCommitBeforeDone` ladder VERBATIM (the strictest site):
 *
 *   1. readEvidence (explicit-reachable-wins; baseline + foreign hard-absent;
 *      R-AICF unreachable-explicit falls to inferred/scan).
 *   2. Single backoff re-read on absent (R-CCGR flush race).
 *   3. Announcement recovery (R-CCEM): persist the worker-announced SHA as
 *      completion_commit_inferred + re-probe.
 *   4. Promote-once (R-WUWC SOFT-variant): persistEvidence writes the committed
 *      SHA into the explicit field (no-ops when already present) + re-probe.
 *   5. decision === 'done-flip' ONLY: worker-gate verdict fail-closed (R-CWGE) —
 *      GREEN required; red / absent / un-injected refuse. 'phantom-watch' and
 *      'attribution' apply everything EXCEPT the verdict: the verdict governs
 *      Done-FLIPS, not keep-decisions — reverting shipped Done work on an absent
 *      verdict would violate R-DSAN never-discard.
 */
/** Type guard: committed evidence carrying a SHA the predicate can act on. */
function isAcceptedEvidence(r: EvidenceResult): r is EvidenceResult & { kind: 'committed'; sha: string } {
  return r.kind === 'committed' && !!r.sha;
}

function refuseAbsent(evidence: EvidenceResult): CompletionDecision {
  return { ok: false, reason: evidence.absentReason ?? 'no_evidence' };
}

/**
 * R-WUWC SOFT-variant promote-once: write the SHA into the explicit
 * completion_commit field (persistEvidence no-ops when already present), then
 * re-probe so the accepted evidence is the durable on-disk state. Best-effort:
 * a persist failure yields null and the caller keeps the pre-persist evidence.
 */
function promoteOnceAndReprobe(ctx: CompletionDecisionCtx, sha: string): EvidenceResult | null {
  try {
    const result = persistEvidence(ctx, sha, { stage: 'best-effort' });
    if (result.action === 'written') {
      return readEvidence(ctx);
    }
  } catch { /* best-effort — fall through to existing classification */ }
  return null;
}

/**
 * R-CWGE: Done requires a GREEN worker-gate verdict; fail-closed. Consulted
 * ONLY for 'done-flip'. An un-injected or throwing resolver reads as
 * absent/unavailable and refuses.
 */
function workerGateRefusal(ctx: CompletionDecisionCtx): CompletionDecision | null {
  if (ctx.decision !== 'done-flip') return null;
  let gate: { verdict: 'green' | 'red' | 'absent'; computedVia: string };
  try {
    gate = ctx.workerGateVerdict
      ? ctx.workerGateVerdict()
      : { verdict: 'absent', computedVia: 'unavailable' };
  } catch {
    gate = { verdict: 'absent', computedVia: 'unavailable' };
  }
  if (gate.verdict === 'green') return null;
  return {
    ok: false,
    reason: gate.verdict === 'red' ? 'worker_gate_red' : 'worker_gate_unavailable',
    gate,
  };
}

export function evaluateCompletionEvidence(ctx: CompletionDecisionCtx): CompletionDecision {
  let evidence = readEvidence(ctx);
  if (!isAcceptedEvidence(evidence)) {
    // R-CCGR: the worker commits + stamps `completion_commit`, then emits its
    // done-promise; a decision site can read this predicate before that
    // frontmatter write is durably visible. Re-read once after a short backoff.
    sleepSyncMs(ctx.rereadBackoffMs ?? defaultRereadBackoffMs());
    evidence = readEvidence(ctx);
  }
  let via: EvidenceVia | 'announcement' | undefined = evidence.via;
  if (!isAcceptedEvidence(evidence)) {
    const recovered = recoverFromAnnouncement(ctx);
    if (recovered) {
      evidence = recovered;
      if (isAcceptedEvidence(recovered)) via = 'announcement';
    }
  }
  if (!isAcceptedEvidence(evidence)) return refuseAbsent(evidence);
  const viaAtAccept: EvidenceVia | 'announcement' = via ?? evidence.via ?? 'scan';
  const reprobed = promoteOnceAndReprobe(ctx, evidence.sha);
  if (reprobed) evidence = reprobed;
  if (!isAcceptedEvidence(evidence)) return refuseAbsent(evidence);
  const refusal = workerGateRefusal(ctx);
  if (refusal) return refusal;
  return { ok: true, sha: evidence.sha, via: viaAtAccept, usedFallback: evidence.usedFallback };
}

// ---------------------------------------------------------------------------
// Entry point 4: gateForPhantomDoneRevert
// ---------------------------------------------------------------------------

/**
 * Decides whether a Done ticket should be reverted (phantom-Done watcher) or
 * kept. B-1SEAM WS-1: thin adapter over `evaluateCompletionEvidence`
 * ({ decision: 'phantom-watch' }) so the watcher and the Done-flip gate share
 * ONE policy — no accept-here-revert-there split. The export name is kept for
 * audit-phantom-done-call-sites.sh and the R-RIC-EXPLICIT-4 pins.
 */
export function gateForPhantomDoneRevert(ctx: EvidenceCtx, _policy?: RevertPolicy): RevertDecision {
  const decision = evaluateCompletionEvidence({
    ...ctx,
    startCommit: ctx.startCommit ?? null,
    pinnedSha: ctx.pinnedSha ?? null,
    decision: 'phantom-watch',
    // Watcher re-checks are not racing a done-promise flush; skip the sleep
    // (the single re-read still runs).
    rereadBackoffMs: 0,
  });
  if (decision.ok) {
    return { action: 'keep', kind: 'committed', sha: decision.sha, fallbackFired: decision.usedFallback };
  }
  return { action: 'revert', kind: 'absent' };
}

