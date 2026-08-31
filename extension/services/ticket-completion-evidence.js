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
import { readFrontmatterField, upsertFrontmatterField, normalizeCompletionCommitField, ticketFilePath, } from './pickle-utils.js';
import { findMissingPrefixes, requiredTierArtifactPrefixes } from './artifact-validation.js';
import { VALID_TICKET_COMPLEXITY_TIERS } from './pickle-utils.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';
/**
 * Count ceiling for the trailer scan, used ONLY when the session carries no
 * usable `startTimeEpoch`. With an epoch, the window is bounded on the SAME
 * axis the entry filter uses (`--since`), never by commit count.
 */
const TRAILER_SCAN_MAX_COMMITS = 2000;
// ---------------------------------------------------------------------------
// Private helpers (inlined from pickle-utils private scope)
// ---------------------------------------------------------------------------
function resolveTicketPath(ctx) {
    if (typeof ctx.ticketPath === 'string' && ctx.ticketPath.length > 0)
        return ctx.ticketPath;
    if (typeof ctx.sessionDir === 'string' && ctx.sessionDir.length > 0 &&
        typeof ctx.ticketId === 'string' && ctx.ticketId.length > 0) {
        return ticketFilePath(ctx.sessionDir, ctx.ticketId);
    }
    return null;
}
/**
 * 3-way git cat-file probe (R-AFCC-DEEP-3C pattern).
 * Returns 'exists' (exit 0), 'not-exists' (exit 1 — the ONE outcome that proves
 * absence), or 'git-could-not-run' (every other outcome — git produced no
 * definitive answer).
 *
 * AP-EXT-ITER111-01: the verdict is decided by testing FOR the one proof, never
 * by enumerating the failures that do not prove it. The prior form listed four
 * survivors (ETIMEDOUT / SIGTERM / exit 128 / ENOENT) and DEFAULTED to a definite
 * 'not-exists', so any unaccountable failure — EACCES on the git binary, an
 * EAGAIN/EMFILE fork failure under tier load, a future non-128 fatal — fabricated
 * "this repo does not have that commit". That fabrication is not inert: it is the
 * one verdict `probeShaOverLadder` treats as final, so it also short-circuited the
 * remaining rungs, and a ticket whose commit the fallback repo could name read
 * as `absent`. Same doctrine as `isProcessAlive` (AP-EXT-ITER109-01): a survivor
 * list is one errno from the next wrong verdict.
 *
 * AP-EXT-ITER76-02: for THIS call shape the 'not-exists' arm is unreachable, and
 * the difference is load-bearing. `git cat-file -e <sha>` exits 1 on a missing
 * object, but the `^{commit}` peel makes it a rev-parse failure — `fatal: Not a
 * valid object name`, exit 128 (re-probed 2026-08-30, git 2.39.5). So "this repo
 * simply does not have that commit" reports 'git-could-not-run', which is what
 * makes `probeShaOverLadder`'s `fallbackDir` rung fire on the ORDINARY case rather
 * than only on a broken checkout. Do not read the 3-state prose as evidence that
 * the fallback rung is rare; any rule that must hold for an accept has to hold on
 * the fallback dir too (see `gitDirLadder`). Keep the `status === 1` arm anyway:
 * it is what makes the verdict follow git's contract rather than this call site's
 * current spelling of it.
 */
function probeCatFile(workingDir, sha) {
    try {
        execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return 'exists';
    }
    catch (err) {
        return err.status === 1 ? 'not-exists' : 'git-could-not-run';
    }
}
/** Shortest abbreviation `normalizeCompletionCommitField` accepts; also the floor here. */
const MIN_ABBREV_SHA_LEN = 7;
/**
 * AP-EXT-ITER5-01: SHA-IDENTITY comparison for the R-CXOR-2 baseline join —
 * "is this the same commit?", never "is this the same spelling?".
 *
 * The two sides of this join arrive in DIFFERENT widths by construction. A
 * stamped field is normalized by `normalizeCompletionCommitField`, which accepts
 * `[0-9a-f]{7,40}` and returns it verbatim; the session baselines are read RAW
 * out of `state.json`, where setup always writes a full 40-char OID. A `===`
 * between them therefore answers the spelling question, and an abbreviated stamp
 * of the baseline sails through the gate that exists to reject it.
 *
 * Git's own abbreviation rule is prefix-identity, so that is what is compared,
 * case-folded (the normalizer's `/i` preserves an uppercase stamp). Both sides
 * must reach `MIN_ABBREV_SHA_LEN` — a truncated/garbage baseline must not become
 * a prefix that rejects every SHA in the session.
 */
function isSameCommitSha(a, b) {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (x.length < MIN_ABBREV_SHA_LEN || y.length < MIN_ABBREV_SHA_LEN)
        return false;
    return x.startsWith(y) || y.startsWith(x);
}
/** R-CXOR-2: true when sha is a session baseline (start_commit or pinned_sha). */
function isBaselineSha(sha, ctx) {
    return (ctx.startCommit != null && isSameCommitSha(sha, ctx.startCommit)) ||
        (ctx.pinnedSha != null && isSameCommitSha(sha, ctx.pinnedSha));
}
/**
 * R-CXOR-2 baseline rejection: owns the decision AND its operator warn. Reached
 * only through `rejectsAccept`, the composed gate every accept arm shares — that
 * indirection is what stops an arm from skipping the check, which is exactly
 * what the inferred arm did (AP-EXT-ITER16-01): it gated on `commitExists`
 * alone, and a baseline SHA is reachable by definition, so an announced baseline
 * classified `committed` and the predicate's promote-once then persisted it into
 * the explicit `completion_commit` field.
 */
function rejectsAsBaseline(sha, ctx) {
    if (!isBaselineSha(sha, ctx))
        return false;
    process.stderr.write(`[ticket-completion-evidence] baseline sha ${sha} rejected as completion evidence — ticket did no work beyond session start\n`);
    return true;
}
/**
 * AP-EXT-ITER123-01: THE accept probe — "can any repo on the ladder resolve this
 * sha?". Every accept arm asks it, so no arm can be decided by a narrower set of
 * dirs than its siblings.
 *
 * It walks `gitDirLadder` rather than carrying its own workingDir/fallbackDir
 * pair, which is what made the divergence possible: this function used to be the
 * ONLY ladder-walking accept path, so the inferred arm (a bare `commitExists` on
 * `ctx.workingDir`) and the scan arm resolved over ONE dir while the explicit arm
 * resolved over two. Same sha, same repo, same ticket — the explicit arm kept a
 * Done ticket via the fallback rung and the other two reverted it to Todo.
 *
 * `'not-exists'` on a rung is FINAL (that rung positively proved absence);
 * `'git-could-not-run'` descends to the next rung, which is the R-CCR-1 case the
 * fallback exists for — an unusable per-ticket `working_dir` cannot answer for
 * ANY arm's sha, not just the explicit one. Per AP-EXT-ITER76-02 the
 * `'not-exists'` arm is unreachable for this call shape; it is kept so the
 * verdict follows git's contract rather than the current spelling of it.
 *
 * Returns the EvidenceResult on success, or null when no rung can resolve the
 * sha (caller maps null → absent).
 */
function probeShaOverLadder(sha, ctx) {
    const dirs = gitDirLadder(ctx);
    for (const [rung, dir] of dirs.entries()) {
        const probe = probeCatFile(dir, sha);
        if (probe === 'exists') {
            return rung === 0 ? { kind: 'committed', sha } : { kind: 'committed', sha, usedFallback: true };
        }
        if (probe !== 'git-could-not-run')
            return null;
    }
    return null;
}
/**
 * AP-EXT-ITER76-01: THE dir ladder. `workingDir` first, then the R-CCR-1
 * `fallbackDir` — ONE definition of "which repo answers for this sha", shared by
 * the accept probe (`probeShaOverLadder`, shared by ALL THREE accept arms) and
 * the R-OMA rejection read
 * (`isForeignAttributedExplicitSha`), so a dir that decides an accept is always a
 * dir the rejection rules were asked in.
 */
function gitDirLadder(ctx) {
    return ctx.fallbackDir && ctx.fallbackDir !== ctx.workingDir
        ? [ctx.workingDir, ctx.fallbackDir]
        : [ctx.workingDir];
}
/**
 * Reads a commit's full message from the FIRST dir on the ladder that can resolve
 * `sha`, lowercased. `''` when no dir on the ladder can answer — which the caller
 * treats as accept, preserving R-RIC-EXPLICIT's "absence of a matching message is
 * never grounds for rejection".
 */
function showCommitMessage(sha, dirs) {
    for (const dir of dirs) {
        try {
            const message = execFileSync('git', ['-C', dir, 'show', '-s', '--format=%B', sha], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().toLowerCase();
            if (message)
                return message;
        }
        catch { /* this dir cannot answer for the sha — try the next rung */ }
    }
    return '';
}
/**
 * WS-2 consumer: parses `git log --format=%H%n%ct%n%(trailers:key=Pickle-Ticket,valueonly)%n---pickle-trailer-boundary---`
 * output. The trailer value is a single git-parsed field, not a free-text message body, so it
 * gets its own dedicated parser rather than a shared generic git-log parser.
 */
function parseTrailerLog(raw) {
    return raw
        .split('\n---pickle-trailer-boundary---\n')
        .map(e => e.trim())
        .filter(Boolean)
        .map(e => {
        const [sha = '', epochRaw = '0', ...rest] = e.split('\n');
        return { sha: sha.trim(), epoch: Number(epochRaw.trim()) || 0, trailerValue: rest.join('\n').trim() };
    })
        .filter(e => /^[0-9a-f]{40}$/i.test(e.sha));
}
/**
 * WS-2 consumer: reads the `Pickle-Ticket` git trailer (stamped by the WS-1 producer hook) via git's
 * own trailer parser — exact ticket-id equality, no word-boundary regex needed since the trailer
 * value IS the ticket id, not a token embedded in free text. A trailer naming a DIFFERENT ticket
 * simply does not match, so there is nothing to launder: WS-3 deleted the message-inference passes
 * that a foreign-attribution exclusion set used to have to defend against.
 *
 * Newest-first-wins, since `git log` iterates newest-first.
 *
 * Best-effort: any git failure returns null, never throws.
 */
function scanGitLogByTrailer(args) {
    if (!args.ticketId)
        return null;
    const wantedId = args.ticketId.trim().toLowerCase();
    if (!wantedId)
        return null;
    const startEpoch = Number(args.startTimeEpoch);
    // ONE window, one axis. The entry filter below rejects anything older than
    // `startEpoch`, so when that bound exists git applies the SAME bound itself
    // (`--since`) and the scan sees every in-session commit. A count cap is a
    // DIFFERENT axis: a 46-ticket bundle authors well past 50 commits (this repo
    // has logged 143 in a single day), so a fixed `-n 50` silently drops an
    // early ticket's correctly-trailered commit out of the window — the scan
    // returns null, evidence reads `absent`, and the Done flip is refused over
    // work that shipped. The count ceiling survives only as the no-epoch arm.
    const windowArgs = Number.isFinite(startEpoch) && startEpoch > 0
        ? ['--since', `@${startEpoch}`]
        : ['-n', String(TRAILER_SCAN_MAX_COMMITS)];
    let raw;
    try {
        raw = execFileSync('git', [
            '-C', args.workingDir,
            'log', ...windowArgs,
            '--format=%H%n%ct%n%(trailers:key=Pickle-Ticket,valueonly)%n---pickle-trailer-boundary---',
            'HEAD',
        ], {
            timeout: 5000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
        });
    }
    catch {
        return null;
    }
    for (const e of parseTrailerLog(raw)) {
        if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch)
            continue;
        if (e.trailerValue.trim().toLowerCase() === wantedId)
            return { sha: e.sha };
    }
    return null;
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
 * against a ticket's OWN commit. A ticket dir is identified via `isTicketDir`:
 * it holds a `rick_ticket_*.md`.
 */
function enumerateSiblingTicketIds(sessionDir, selfTicketId) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    const selfLower = selfTicketId ? selfTicketId.toLowerCase() : null;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const id = entry.name.toLowerCase();
        if (selfLower && id === selfLower)
            continue;
        if (!isTicketDir(path.join(sessionDir, entry.name)))
            continue;
        out.push(id);
    }
    return out;
}
/** True iff `dir` holds a `rick_ticket_<hash>.md` artifact (i.e. it is a ticket dir). */
function isTicketDir(dir) {
    try {
        return fs.readdirSync(dir).some(f => f.startsWith('rick_ticket_') && f.endsWith('.md'));
    }
    catch {
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
 * a generic or own-ticket message returns false (accept). Word-boundary matching is
 * needed here because this arm searches a free-text commit message, where a ticket id
 * appears as an embedded token; the trailer scan (`scanGitLogByTrailer`) instead compares
 * a single git-parsed field for exact equality and needs no such matcher.
 */
function isForeignAttributedExplicitSha(sha, ctx, content) {
    if (!ctx.sessionDir)
        return false;
    const selfId = readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null;
    const siblingIds = enumerateSiblingTicketIds(ctx.sessionDir, selfId);
    if (siblingIds.length === 0)
        return false;
    const message = showCommitMessage(sha, gitDirLadder(ctx));
    if (!message)
        return false;
    const wordBoundary = (token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    // Own attribution wins: never reject a commit that names this ticket's id/r_code.
    // R-PDUP: sanctioned twin-borrow tokens count as own attribution too.
    const selfRCode = readFrontmatterField(content, 'r_code');
    const ownTokens = [
        ...(selfId ? [selfId.toLowerCase()] : []),
        ...(selfRCode ? [selfRCode.trim().toLowerCase()] : []),
        ...(ctx.ownAttributionTokens ?? []).map(t => t.trim().toLowerCase()),
    ].filter(Boolean);
    if (ownTokens.some(t => wordBoundary(t).test(message)))
        return false;
    // Foreign positive: the message names a DIFFERENT ticket id.
    return siblingIds.some(id => wordBoundary(id).test(message));
}
/**
 * AP-EXT-ITER16-01/-02: THE rejection gate. Every `readEvidence` accept arm —
 * explicit, inferred, scan — passes its candidate SHA through this ONE function,
 * so a rejection rule cannot land on two arms and silently miss the third. That
 * is not hypothetical: both rules shipped wired to explicit+scan only, and the
 * inferred arm gated on `commitExists` alone, so ONE sha drew THREE verdicts
 * depending on which field carried it.
 *
 * Reachability can substitute for neither rule: a baseline SHA is git-reachable
 * BY CONSTRUCTION, and a foreign-attributed SHA is a real commit — just someone
 * else's. Both owns their own operator warn, so no caller can drop it.
 *
 * AP-EXT-ITER76-01: the gate is uniform on the DIR axis too, not just the arm
 * axis. `isForeignAttributedExplicitSha` reads the commit message over the same
 * `gitDirLadder` the accept probe resolves on, so an accept decided by the
 * R-CCR-1 `fallbackDir` cannot be one R-OMA was never asked about.
 *
 * Callers own only the `absentReason` their arm reports: the stamped-field arms
 * (explicit, inferred) surface the hard reason, while the scan arm downgrades to
 * `no_evidence` — a scan miss is best-effort, not a positive finding (see the
 * WS-2 arm-agreement cases in tests/nostop-gates-arm-agreement.test.js).
 */
function rejectsAccept(sha, ctx, content) {
    if (rejectsAsBaseline(sha, ctx))
        return 'baseline_sha';
    if (isForeignAttributedExplicitSha(sha, ctx, content)) {
        process.stderr.write(`[ticket-completion-evidence] sha ${sha} rejected — positively attributed to a different ticket (R-OMA foreign-attribution)\n`);
        return 'foreign_attribution';
    }
    return null;
}
/**
 * B-GITATTR WS-3: `scanGitLog` is reduced to the trailer lookup — the
 * message-inference passes (ref-token, declared-file-touch) are gone now that
 * the `Pickle-Ticket` trailer produces and consumes attribution directly.
 */
function scanGitLog(args) {
    // AP-EXT-ITER123-01: walks the same `gitDirLadder` as the stamped-field arms.
    // `scanGitLogByTrailer` stays the single-dir primitive (mirroring
    // `showCommitMessage`), so the ladder has exactly one definition and the
    // execFileSync inventory is unchanged.
    for (const dir of args.dirs) {
        const hit = scanGitLogByTrailer({
            workingDir: dir,
            ticketId: args.ticketId,
            startTimeEpoch: args.startTimeEpoch,
        });
        if (hit)
            return hit;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Entry point 1: readEvidence
// ---------------------------------------------------------------------------
/**
 * The stamped `completion_commit_inferred` arm, extracted so `readEvidence`
 * stays under the eslint complexity ceiling (W5b: absorb a variant by
 * re-shaping, never by incrementing the caller's branch count).
 *
 * Passes its candidate through the SAME `rejectsAccept` gate as its explicit
 * sibling (AP-EXT-ITER16-01/-02) — `commitExists` alone catches neither a
 * baseline SHA nor a borrowed one, since both are reachable commits. `inferred`
 * is a stamped field like `completion_commit`, so it reports the hard reason.
 *
 * Returns null ONLY when the field is absent — that is the caller's signal to
 * fall through to the git-log scan arm. A present-but-unusable field
 * short-circuits via `absent()` (the scan would fail for the same reason).
 */
function readInferredArm(ctx, content, absent) {
    const inferredField = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred'));
    if (!inferredField)
        return null;
    const rejection = rejectsAccept(inferredField, ctx, content);
    if (rejection)
        return { kind: 'absent', absentReason: rejection };
    // AP-EXT-ITER123-01: the SAME ladder the explicit arm accepts over. A bare
    // `commitExists(ctx.workingDir, …)` here made an unusable per-ticket
    // working_dir revert a Done ticket whose sha the fallback repo could name.
    const probed = probeShaOverLadder(inferredField, ctx);
    if (probed)
        return { ...probed, via: 'inferred' };
    // R-AFCC-STAGE: field present but git can't verify (non-repo workingDir or a
    // dropped commit). A stored-but-unverifiable SHA is not evidence the gate can
    // act on → absent.
    return absent();
}
/**
 * Reads completion evidence for a ticket and returns a 2-state EvidenceKind
 * (B-DURA T70):
 *   - committed: explicit completion_commit (git-reachable), git-verified
 *     completion_commit_inferred field, or a git-log scan hit.
 *   - absent: no field/scan match, an explicit SHA that is not git-reachable, a
 *     baseline SHA (R-CXOR-2), or a stored-but-unverifiable inferred SHA.
 */
export function readEvidence(ctx) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { kind: 'absent' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { kind: 'absent' };
    }
    // --- Explicit completion_commit field ---
    const explicit = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit'));
    let unreachableExplicit = false;
    if (explicit) {
        // R-CXOR-2 (baseline: the ticket did no work beyond session start) and R-OMA
        // (foreign: a no-op ticket borrowing another ticket's commit hash) are both
        // hard-absent for a stamped field. Default is accept — explicit-SHA-wins.
        const rejection = rejectsAccept(explicit, ctx, content);
        if (rejection)
            return { kind: 'absent', absentReason: rejection };
        const r = probeShaOverLadder(explicit, ctx);
        if (r)
            return { ...r, via: 'explicit' };
        // R-AICF: explicit SHA present but UNREACHABLE (hallucinated/dropped stamp).
        // No longer hard-absent — fall through to the inferred-field and git-log-scan
        // branches so real untagged work is still attributable. Baseline-rejected and
        // foreign-attributed explicit SHAs above stay hard-absent.
        unreachableExplicit = true;
        process.stderr.write(`[ticket-completion-evidence] explicit sha ${explicit} unreachable — falling through to inferred/scan attribution (R-AICF)\n`);
    }
    const absent = () => ({
        kind: 'absent',
        absentReason: unreachableExplicit ? 'unreachable_explicit_unattributable' : 'no_evidence',
    });
    // --- Inferred field (completion_commit_inferred) ---
    const inferred = readInferredArm(ctx, content, absent);
    if (inferred)
        return inferred;
    // --- Git log scan (WS-2 Pickle-Ticket trailer) ---
    const selfId = readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null;
    const scan = scanGitLog({
        dirs: gitDirLadder(ctx),
        ticketId: selfId,
        startTimeEpoch: ctx.startTimeEpoch,
    });
    if (scan) {
        // Scan-arm rejections stay a best-effort miss (`no_evidence`), never the
        // hard stamped-field reason — see rejectsAccept's docstring.
        if (rejectsAccept(scan.sha, ctx, content))
            return absent();
        return { kind: 'committed', sha: scan.sha, via: 'scan' };
    }
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
export function persistEvidence(ctx, sha, opts) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { action: 'no_file' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { action: 'no_file' };
    }
    if (readFrontmatterField(content, 'completion_commit')) {
        return { action: 'already_present', sha: readFrontmatterField(content, 'completion_commit') ?? sha };
    }
    const updated = upsertFrontmatterField(content, 'completion_commit', sha);
    if (!updated)
        return { action: 'unwritable' };
    try {
        fs.writeFileSync(tPath, updated);
    }
    catch {
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
    }
    catch {
        if (opts.stage === 'required')
            throw new Error(`persistEvidence: git add failed for ${tPath}`);
        // best-effort: staged stays false
    }
    return { action: 'written', sha, staged };
}
const ZERO_DIFF_INTENTS = new Set([
    'verification',
    'audit',
    'already-satisfied',
]);
/**
 * R-CCGR: a process-blocking sleep for the single backoff re-read.
 * `Atomics.wait` blocks without spawning a child process.
 */
function sleepSyncMs(ms) {
    if (!(ms > 0))
        return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch { /* SharedArrayBuffer disabled — skip the backoff */ }
}
/** R-CCGR backoff before the single re-read; env-overridable, clamped. */
function defaultRereadBackoffMs() {
    const raw = Number(process.env.PICKLE_GUARD_REREAD_BACKOFF_MS);
    if (Number.isFinite(raw) && raw >= 0)
        return Math.min(raw, 5000);
    return 500;
}
/**
 * R-CCEM: absent evidence + a worker-announced commit SHA → persist the worker's
 * OWN declared SHA as `completion_commit_inferred` and re-probe (absorbs
 * mux-runner's recoverInferredFromAnnouncement). Best-effort; never overwrites
 * an explicit `completion_commit`.
 *
 * AP-EXT-ITER23-01: the candidate is judged by `rejectsAccept` BEFORE it is
 * written, like every other arm. Re-probing AFTER the write does not contain a
 * bad SHA — it only classifies one: the durable `completion_commit_inferred:`
 * stamp survives the refusal, and the mux-runner oracles that read that field
 * (`resolveAttributableFrontmatterSha`, `hasPresentCompletionCommitField`) carry
 * NO baseline or attribution check. A baseline SHA is git-reachable BY
 * CONSTRUCTION and a borrowed one is a real commit, so both pass their git-only
 * probe: silent-death recovery reads `hold` (respawn suppressed) and the
 * Failed-flip is suppressed, wedging a ticket that did no work. The announced
 * value is shape-validated only (`readAnnouncedCompletionSha`), so this is the
 * one place the rule can apply. Reports the hard reason like its stamped-field
 * sibling `readInferredArm`, which also keeps `zeroDiffAccept` from laundering
 * the refusal into a declared zero-diff accept.
 */
function recoverFromAnnouncement(ctx) {
    if (!ctx.announcedSha)
        return null;
    let announced;
    try {
        announced = ctx.announcedSha();
    }
    catch {
        return null;
    }
    if (!announced)
        return null;
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return null;
    try {
        const raw = fs.readFileSync(tPath, 'utf8');
        if (!readFrontmatterField(raw, 'completion_commit')) {
            const rejection = rejectsAccept(announced, ctx, raw);
            if (rejection)
                return { kind: 'absent', absentReason: rejection };
            const upd = upsertFrontmatterField(raw, 'completion_commit_inferred', announced);
            if (upd) {
                fs.writeFileSync(tPath, upd);
                return readEvidence(ctx);
            }
        }
    }
    catch { /* best-effort — fall through to existing classification */ }
    return null;
}
/**
 * WS-2 (fix a): true iff `evidence` is a scan-sourced accept for a ticket that
 * DECLARES a recognized `zero_diff_intent`. A declared zero-diff ticket must
 * never have scan-sourced evidence promoted into its explicit field — the scan
 * arm's best-effort guess (bundle-generic ref-token matches, per the research)
 * is never a legitimate borrow target for a ticket that declares it produces no
 * commit of its own. Read-only: consults the existing `ctx.zeroDiffIntent()`
 * resolver, adds no new write and no new call site of the `zero_diff_intent`
 * frontmatter key (the sanctioned single-occurrence pin stays intact).
 */
function isZeroDiffScanBorrowExcluded(ctx, evidence) {
    if (evidence.kind !== 'committed' || evidence.via !== 'scan')
        return false;
    if (!ctx.zeroDiffIntent)
        return false;
    let declared;
    try {
        declared = ctx.zeroDiffIntent();
    }
    catch {
        return false;
    }
    const intent = declared?.trim().toLowerCase();
    return !!intent && ZERO_DIFF_INTENTS.has(intent);
}
/**
 * B-1SEAM WS-1: the ONE completion predicate — the single policy answering
 * "may this ticket's completion evidence be acted on?". Policy is the shipped
 * `guardCompletionCommitBeforeDone` ladder VERBATIM (the strictest site):
 *
 *   1. readEvidence (explicit-reachable-wins; baseline + foreign hard-absent;
 *      R-AICF unreachable-explicit falls to inferred/scan).
 *   2. Single backoff re-read on absent (R-CCGR flush race).
 *   3. Announcement recovery (R-CCEM): judge the worker-announced SHA through the
 *      shared `rejectsAccept` gate, then persist it as completion_commit_inferred
 *      + re-probe (AP-EXT-ITER23-01: judged BEFORE the write, never after).
 *   3b. B-GTRUTH WS-A1 zero-diff arm: with every attribution path exhausted, a ticket
 *      that DECLARES a recognized `zero_diff_intent` and has its tier's lifecycle
 *      artifacts on disk is complete WITHOUT a SHA (verdict required on 'done-flip',
 *      exempt on the 'phantom-watch' keep, refused for 'attribution'). Placed after
 *      every attribution branch so committed evidence always wins, and before
 *      `refuseAbsent` so the declaration is the last thing consulted, never the first.
 *   4. Promote-once (R-WUWC SOFT-variant): persistEvidence writes the committed
 *      SHA into the explicit field (no-ops when already present) + re-probe.
 *   5. decision === 'done-flip' ONLY: worker-gate verdict fail-closed (R-CWGE) —
 *      GREEN required; red / absent / un-injected refuse. 'phantom-watch' and
 *      'attribution' apply everything EXCEPT the verdict: the verdict governs
 *      Done-FLIPS, not keep-decisions — reverting shipped Done work on an absent
 *      verdict would violate R-DSAN never-discard.
 */
/** Type guard: committed evidence carrying a SHA the predicate can act on. */
function isAcceptedEvidence(r) {
    return r.kind === 'committed' && !!r.sha;
}
function refuseAbsent(evidence) {
    return { ok: false, reason: evidence.absentReason ?? 'no_evidence' };
}
/**
 * R-WUWC SOFT-variant promote-once: write the SHA into the explicit
 * completion_commit field (persistEvidence no-ops when already present), then
 * re-probe so the accepted evidence is the durable on-disk state. Best-effort:
 * a persist failure yields null and the caller keeps the pre-persist evidence.
 */
function promoteOnceAndReprobe(ctx, sha) {
    try {
        const result = persistEvidence(ctx, sha, { stage: 'best-effort' });
        if (result.action === 'written') {
            return readEvidence(ctx);
        }
    }
    catch { /* best-effort — fall through to existing classification */ }
    return null;
}
/**
 * R-CWGE: Done requires a GREEN worker-gate verdict; fail-closed. Consulted
 * ONLY for 'done-flip'. An un-injected or throwing resolver reads as
 * absent/unavailable and refuses.
 */
function workerGateRefusal(ctx) {
    if (ctx.decision !== 'done-flip')
        return null;
    let gate;
    try {
        gate = ctx.workerGateVerdict
            ? ctx.workerGateVerdict()
            : { verdict: 'absent', computedVia: 'unavailable' };
    }
    catch {
        gate = { verdict: 'absent', computedVia: 'unavailable' };
    }
    if (gate.verdict === 'green')
        return null;
    return {
        ok: false,
        reason: gate.verdict === 'red' ? 'worker_gate_red' : 'worker_gate_unavailable',
        gate,
    };
}
/**
 * B-GTRUTH WS-A1: the ticket's lifecycle artifacts are all present on disk.
 *
 * The required prefix set is derived from the ticket's OWN declared
 * `complexity_tier` via `requiredTierArtifactPrefixes` (which reads
 * `TIER_LIFECYCLE`) — never a hardcoded list. An absent or unrecognized tier
 * REFUSES: `normalizeTicketComplexityTier` would default it to `medium`, and
 * silently inventing a tier for a ticket that never declared one is exactly the
 * proxy-over-truth move this arm exists to remove.
 *
 * Fail-closed: any read error yields false, so a zero-diff accept never rests on
 * an unreadable ticket directory.
 */
function hasLifecycleArtifacts(ctx) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return false;
    try {
        const raw = fs.readFileSync(tPath, 'utf8');
        const declaredTier = readFrontmatterField(raw, 'complexity_tier')?.trim().toLowerCase();
        if (!declaredTier || !VALID_TICKET_COMPLEXITY_TIERS.includes(declaredTier)) {
            return false;
        }
        const required = requiredTierArtifactPrefixes(declaredTier);
        const files = fs.readdirSync(path.dirname(tPath));
        return findMissingPrefixes(files, required).length === 0;
    }
    catch {
        return false;
    }
}
/**
 * B-GTRUTH WS-A1: the zero-diff completion arm — the ONE place "complete, and
 * correctly produced no diff" becomes representable.
 *
 * Three independent conditions, ALL required; none is inferred:
 *   1. the ticket DECLARES a recognized `zero_diff_intent`;
 *   2. its tier's lifecycle artifacts are all on disk (the work actually happened);
 *   3. `done-flip` additionally requires a GREEN worker-gate verdict (R-CWGE).
 *
 * Decision-kind reach:
 *   - `done-flip`     — accept (with the verdict), so the Done flip is permitted.
 *   - `phantom-watch` — accept as a KEEP. Without this the arm is inert BY
 *     CONSTRUCTION: a zero-diff Done carries no `completion_commit`, so the
 *     phantom-Done watcher would revert it on the next sweep. The verdict is
 *     exempt here for the same reason it is exempt for every other keep-decision
 *     (see the ladder note above: reverting shipped Done work on an absent
 *     verdict violates R-DSAN never-discard).
 *   - `attribution`   — REFUSED. `isTicketOracleCommitted` feeds
 *     `reportPhaseIncomplete`'s unfinished roster; admitting a declaration there
 *     would let a frontmatter field hide a genuinely-unfinished ticket from the
 *     operator, which is the failure this bundle removes rather than relocates.
 *
 * Hard-absent evidence (`baseline_sha` R-CXOR-2, `foreign_attribution` R-OMA) is
 * NEVER laundered by a declaration: those mean a stamp was positively
 * mis-attributed, and a zero-diff ticket has no business carrying a stamp at all.
 */
function zeroDiffAccept(ctx, evidence) {
    if (ctx.decision === 'attribution')
        return null;
    if (evidence.absentReason === 'baseline_sha' || evidence.absentReason === 'foreign_attribution') {
        return null;
    }
    if (!ctx.zeroDiffIntent)
        return null;
    let declared;
    try {
        declared = ctx.zeroDiffIntent();
    }
    catch {
        return null;
    }
    const intent = declared?.trim().toLowerCase();
    if (!intent || !ZERO_DIFF_INTENTS.has(intent))
        return null;
    if (!hasLifecycleArtifacts(ctx))
        return null;
    if (ctx.decision === 'done-flip') {
        // Return the gate's OWN refusal rather than null. Falling through to
        // `refuseAbsent` would report `no_evidence` — true but useless — for a ticket
        // whose declaration and artifacts both checked out and whose only problem is a
        // red/unverifiable gate. Surfacing `worker_gate_red` / `worker_gate_unavailable`
        // also routes this through the existing R-CWGE `worker_gate_verdict_fail_closed`
        // telemetry in `guardCompletionCommitBeforeDone`.
        const gateRefusal = workerGateRefusal(ctx);
        if (gateRefusal)
            return gateRefusal;
    }
    return { ok: true, via: 'zero-diff', zeroDiffIntent: intent };
}
export function evaluateCompletionEvidence(ctx) {
    let evidence = readEvidence(ctx);
    if (isZeroDiffScanBorrowExcluded(ctx, evidence)) {
        evidence = { kind: 'absent', absentReason: 'no_evidence' };
    }
    if (!isAcceptedEvidence(evidence)) {
        // R-CCGR: the worker commits + stamps `completion_commit`, then emits its
        // done-promise; a decision site can read this predicate before that
        // frontmatter write is durably visible. Re-read once after a short backoff.
        sleepSyncMs(ctx.rereadBackoffMs ?? defaultRereadBackoffMs());
        evidence = readEvidence(ctx);
        if (isZeroDiffScanBorrowExcluded(ctx, evidence)) {
            evidence = { kind: 'absent', absentReason: 'no_evidence' };
        }
    }
    let via = evidence.via;
    if (!isAcceptedEvidence(evidence)) {
        const recovered = recoverFromAnnouncement(ctx);
        if (recovered) {
            evidence = recovered;
            if (isAcceptedEvidence(recovered))
                via = 'announcement';
        }
    }
    if (!isAcceptedEvidence(evidence)) {
        // B-GTRUTH WS-A1: no attributable commit — but a DECLARED zero-diff ticket with
        // its artifacts (and, on a Done-flip, a green gate) is complete, not absent.
        // Placed here so committed evidence always wins: the arm is reached only after
        // every attribution path has come up empty.
        const zeroDiff = zeroDiffAccept(ctx, evidence);
        if (zeroDiff)
            return zeroDiff;
        return refuseAbsent(evidence);
    }
    const viaAtAccept = via ?? evidence.via ?? 'scan';
    const reprobed = promoteOnceAndReprobe(ctx, evidence.sha);
    if (reprobed)
        evidence = reprobed;
    if (!isAcceptedEvidence(evidence))
        return refuseAbsent(evidence);
    const refusal = workerGateRefusal(ctx);
    if (refusal)
        return refusal;
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
export function gateForPhantomDoneRevert(ctx, _policy) {
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
