/**
 * R-CECB: per-ticket declared in-scope file reader.
 *
 * Parses a ticket's markdown for the file paths it declares as in-scope, reading
 * both the `## Files to modify` / `## Files to create` / `## Files to modify/create`
 * / `## Implementation Details` heading sections AND the `**Files to (modify|create)**:`
 * inline-bold-label lines. Consumed by the completion-evidence branch-attribution
 * path: a post-startTimeEpoch green commit that touches one of these declared files
 * attributes to the ticket even when the subject carries no id/r_code/LOA token.
 *
 * Pure (content string -> string[]); no I/O. The evidence module owns sibling
 * enumeration + git probing.
 */
/** Heading sections whose backticked tokens are declared-file candidates. */
const DECLARED_FILE_HEADINGS = [
    'files to modify/create',
    'files to modify',
    'files to create',
    'implementation details',
];
/** `**Files to modify**:` / `**Files to create**:` inline-bold label line. */
const INLINE_FILE_LABEL_RE = /\*\*\s*files to (?:modify|create)\s*\*\*\s*:/i;
/** Known source-file extensions used to recognize path-shaped backticked tokens. */
const PATH_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.sh'];
/** Pulls every backticked token out of a line. */
function backtickedTokens(line) {
    return Array.from(line.matchAll(/`([^`]+)`/g), m => m[1].trim()).filter(Boolean);
}
/** True when a backticked token looks like a file path (not a dotted symbol). */
function isPathShaped(token) {
    if (/\s/.test(token))
        return false;
    if (token.includes('/'))
        return true;
    const lower = token.toLowerCase();
    return PATH_EXTENSIONS.some(ext => lower.endsWith(ext));
}
/** Strips a single leading `./` so `./foo/bar.ts` and `foo/bar.ts` unify. */
function normalizePath(token) {
    return token.startsWith('./') ? token.slice(2) : token;
}
function isHeadingLine(line) {
    return /^#{1,6}\s/.test(line.trim());
}
function headingMatchesDeclaredSection(line) {
    const text = line.trim().replace(/^#{1,6}\s+/, '').toLowerCase();
    return DECLARED_FILE_HEADINGS.some(h => text.startsWith(h));
}
/**
 * Returns the de-duped (first-seen order) set of declared in-scope file paths
 * declared by the ticket markdown.
 */
export function readDeclaredFiles(content) {
    const out = [];
    const seen = new Set();
    const add = (token) => {
        if (!isPathShaped(token))
            return;
        const norm = normalizePath(token);
        if (seen.has(norm))
            return;
        seen.add(norm);
        out.push(norm);
    };
    const lines = content.split(/\r?\n/);
    let inDeclaredSection = false;
    for (const line of lines) {
        if (isHeadingLine(line)) {
            inDeclaredSection = headingMatchesDeclaredSection(line);
            continue;
        }
        // Inline bold-label lines count regardless of the current section.
        const inlineLabel = INLINE_FILE_LABEL_RE.test(line);
        if (inDeclaredSection || inlineLabel) {
            for (const token of backtickedTokens(line))
                add(token);
        }
    }
    return out;
}
