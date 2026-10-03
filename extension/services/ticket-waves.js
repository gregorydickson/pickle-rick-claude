/**
 * Pure ticket-wave scheduler: given pending candidates and a cap, decides which ids
 * may run together in the next wave. Does not read ticket files or run anything —
 * callers own disk I/O and execution (see `ticket-declared-files.ts` for the file
 * declarations this module's `WaveCandidate.files` is expected to be populated from).
 */
import { extractFrontmatter } from './pickle-utils.js';
/** Matches the sole recognized frontmatter opt-in: `parallel_safe: true`. */
const PARALLEL_SAFE_RE = /^parallel_safe:\s*true\s*$/m;
/** `parallel_safe: true` in frontmatter is the only accepted opt-in — a body line (a quoted template) is not. */
export function readParallelSafe(content) {
    const fm = extractFrontmatter(content);
    return fm !== null && PARALLEL_SAFE_RE.test(fm.body);
}
/** `CLAUDE.md`, a nested `CLAUDE.md`, or anything under `.claude/` overlaps everything. */
function isGlobalMarker(token) {
    if (token === 'CLAUDE.md' || token.endsWith('/CLAUDE.md'))
        return true;
    return token === '.claude' || token.startsWith('.claude/');
}
/**
 * A compiled `extension/<x>.js` also spells its source `extension/src/<x>.ts` — every compiled
 * tree (bin, services, hooks, lib, types, scripts, ...) mirrors `src/`, so no directory list.
 */
function spellings(token) {
    if (!token.startsWith('extension/') || token.startsWith('extension/src/') || !token.endsWith('.js'))
        return [token];
    return [token, `extension/src/${token.slice('extension/'.length, -3)}.ts`];
}
function basename(token) {
    const idx = token.lastIndexOf('/');
    return idx === -1 ? token : token.slice(idx + 1);
}
/** `a` names `b` itself, or a directory (trailing slash or not) that contains `b`. */
function contains(a, b) {
    return b === a || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}
function spellingsOverlap(a, b) {
    if (contains(a, b) || contains(b, a))
        return true;
    return (!a.includes('/') || !b.includes('/')) && basename(a) === basename(b);
}
function tokensOverlap(a, b) {
    if (isGlobalMarker(a) || isGlobalMarker(b))
        return true;
    return spellings(a).some(sa => spellings(b).some(sb => spellingsOverlap(sa, sb)));
}
/** An empty list overlaps everything (an unknown file set can't be proven disjoint). */
export function filesOverlap(a, b) {
    if (a.length === 0 || b.length === 0)
        return true;
    for (const tokenA of a) {
        for (const tokenB of b) {
            if (tokensOverlap(tokenA, tokenB))
                return true;
        }
    }
    return false;
}
/**
 * Plans the next wave: sorts by `order`, always starts with the lowest-order pending
 * candidate, and — only when that candidate is `parallelSafe` — appends subsequent
 * candidates while each remains `parallelSafe` and non-overlapping with every wave
 * member so far, stopping at the first candidate that fails either test.
 */
export function planTicketWave(pending, cap) {
    if (pending.length === 0)
        return [];
    const sorted = [...pending].sort((a, b) => a.order - b.order);
    const first = sorted[0];
    if (!first.parallelSafe)
        return [first.id];
    const limit = Math.max(cap, 1);
    const wave = [first];
    for (let i = 1; i < sorted.length && wave.length < limit; i++) {
        const candidate = sorted[i];
        if (!candidate.parallelSafe)
            break;
        if (wave.some(member => filesOverlap(member.files, candidate.files)))
            break;
        wave.push(candidate);
    }
    return wave.map(w => w.id);
}
