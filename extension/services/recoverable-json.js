import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { isProcessAlive } from '../lib/process-liveness.js';
function readProcessStartTimeMs(pid) {
    try {
        const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8',
            timeout: 1000,
        }).trim();
        if (!output)
            return null;
        const startedAt = Date.parse(output);
        return Number.isFinite(startedAt) ? startedAt : null;
    }
    catch {
        return null;
    }
}
function shouldSkipLiveTmp(tmpPid, tmpPath) {
    if (!Number.isFinite(tmpPid) || !isProcessAlive(tmpPid))
        return false;
    const processStartTimeMs = readProcessStartTimeMs(tmpPid);
    if (processStartTimeMs === null)
        return true;
    try {
        return fs.statSync(tmpPath).mtimeMs >= processStartTimeMs;
    }
    catch {
        return true;
    }
}
function parseJsonObjectFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function readJsonObjectFile(filePath) {
    // Delete authority is "positively proven garbage" = READ succeeded AND the
    // content is unparseable. A read that THREW proves nothing about the content,
    // whatever the errno — so the read and the parse are judged separately here
    // rather than through an errno allowlist. Mirrors `state-manager.ts`
    // `classifyOrphanTmp`, which has always had this shape.
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return { kind: 'unreadable' };
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { kind: 'parsed', parsed }
            : { kind: 'invalid' };
    }
    catch {
        return { kind: 'invalid' };
    }
}
function listEntries(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return null;
    }
}
function parseDeadTmp(tmpPath, baseMtimeMs) {
    const parsedResult = readJsonObjectFile(tmpPath);
    if (parsedResult.kind === 'unreadable') {
        return null;
    }
    if (parsedResult.kind !== 'parsed') {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore invalid tmp cleanup failure */ }
        return null;
    }
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(tmpPath).mtimeMs;
    }
    catch {
        return null;
    }
    // R-CIFB-B: an orphan .tmp.<pid> is written AFTER its base, so on a coarse-mtime
    // FS tie (Linux) the tmp is the more-recent intent and MUST win — discard only a
    // STRICTLY-older tmp (`<`, not `<=`). The equal-mtime tmp is kept here and decided
    // by the winner-selection tie-break in readRecoverableJsonObject.
    if (mtimeMs < baseMtimeMs) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore stale tmp cleanup failure */ }
        return null;
    }
    return { parsed: parsedResult.parsed, mtimeMs };
}
/**
 * The PROMOTABLE SET of `filePath`: every `<base>.tmp.<pid>[.…]` sibling this module is
 * willing to rename ONTO `filePath`. ONE definition, shared by the reader below and
 * `removeRecoverableJsonObject`, so a deleter can never disagree with the reader about
 * what "the file" is — the divergence that produced AP-BIN-ITER78-01 and AP-BIN-ITER79-01.
 * Iteration order is readdir order, which the reader's equal-mtime tie-break relies on.
 */
function listPromotableTmpSiblings(filePath) {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const entries = listEntries(dir);
    if (!entries)
        return [];
    const tmpPrefix = baseName + '.tmp.';
    const tmpPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp\\.(\\d+)(?:\\..+)?$`);
    const siblings = [];
    for (const entry of entries.filter(e => e.startsWith(tmpPrefix))) {
        const match = entry.match(tmpPattern);
        if (!match)
            continue;
        siblings.push({ tmpPath: path.join(dir, entry), tmpPid: Number(match[1]) });
    }
    return siblings;
}
/**
 * Remove the whole promotable set of `filePath`, not just the base name. Returns true when
 * anything was removed.
 *
 * Deleting the base ALONE does not delete the file: with the base gone `baseMtimeMs` is 0, so
 * the `mtimeMs < baseMtimeMs` discard in `parseDeadTmp` can never fire and the very next
 * `readRecoverableJsonObject` renames a surviving orphan straight back onto `filePath`,
 * undoing the delete in silence. A live writer's tmp is SKIPPED for the same reason the
 * reader skips it — it is an in-flight write, not an orphan — so this removes exactly what
 * the reader would have promoted.
 */
export function removeRecoverableJsonObject(filePath) {
    let removed = false;
    for (const { tmpPath, tmpPid } of listPromotableTmpSiblings(filePath)) {
        if (shouldSkipLiveTmp(tmpPid, tmpPath))
            continue;
        try {
            fs.unlinkSync(tmpPath);
            removed = true;
        }
        catch { /* ignore orphan cleanup failure */ }
    }
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            removed = true;
        }
    }
    catch { /* ignore base cleanup failure */ }
    return removed;
}
export function readRecoverableJsonObject(filePath) {
    const base = parseJsonObjectFile(filePath);
    let baseMtimeMs;
    try {
        baseMtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    }
    catch {
        baseMtimeMs = 0;
    }
    let winner = null;
    for (const { tmpPath, tmpPid } of listPromotableTmpSiblings(filePath)) {
        if (shouldSkipLiveTmp(tmpPid, tmpPath))
            continue;
        const candidate = parseDeadTmp(tmpPath, baseMtimeMs);
        // R-CIFB-B PINNED ORDERING: among multiple competing dead tmps, strict `>` means
        // the winner is replaced ONLY by a strictly-newer mtime, so equal-mtime tmps are
        // resolved first-seen-wins (readdir iteration order). This is deterministic and
        // documented — do NOT relax to `>=` (that would make last-seen win on a tie).
        if (candidate && (!winner || candidate.mtimeMs > winner.mtimeMs)) {
            winner = { tmpPath, ...candidate };
        }
    }
    if (!winner)
        return base;
    try {
        fs.renameSync(winner.tmpPath, filePath);
        return winner.parsed;
    }
    catch {
        return base;
    }
}
