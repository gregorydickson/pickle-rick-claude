import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
// R-SIGF: shared detector module for signature-change-caller-gap analysis.
// Consumed by check-readiness.ts (WS-1/WS-2) and forward by WS-3 (scope-resolution).
// Moved here from check-readiness.ts to avoid divergent copies.
const GIT_LS_FILES_TIMEOUT_MS = 30_000;
// R-SIGF: the single cap literal for the bounded scope auto-extension. Homed here
// in the shared detector module because both consumers (check-readiness.ts gating
// and pipeline-runner.ts build-phase auto-extension) already import this module —
// one definition, no divergent mirrors (ticket c6051d64 DRY invariant).
export const SCOPE_AUTO_EXTEND_MAX = 8;
export const CALLER_CANDIDATE_MAX = 512;
// Escape a string for literal use inside a RegExp. Homed once here because the
// detector builds several dynamic matchers from ticket-named symbols (arity
// `new X(`, schema `.parse(`/`z.infer`, factory-bridge names) and each must
// escape the same metacharacter set — one definition, no divergent copies.
function escapeRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function gitTrackedFiles(repoRoot) {
    const result = spawnSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: GIT_LS_FILES_TIMEOUT_MS,
    });
    if (result.status !== 0)
        return [];
    return result.stdout.split('\n').filter(Boolean);
}
export function createResolverCache(repoRoot, maxWallMs, allowlist = new Set()) {
    // R-RTRC-3: lift the tests/ exclusion ONLY. Symbols defined in test files
    // (helpers, test fixtures) are valid resolution targets — the prior filter
    // produced false positives whenever a ticket cited a test-defined helper.
    // Extension allowlist (ts|tsx|js|jsx|mjs|cjs) is unchanged.
    const tracked = gitTrackedFiles(repoRoot)
        .filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    return {
        trackedSourceFiles: tracked,
        fileContents: new Map(),
        deadline: Date.now() + maxWallMs,
        truncated: false,
        allowlist,
    };
}
function readCachedFile(absPath, cache) {
    const cached = cache.fileContents.get(absPath);
    if (cached !== undefined)
        return cached;
    try {
        const content = fs.readFileSync(absPath, 'utf-8');
        cache.fileContents.set(absPath, content);
        return content;
    }
    catch {
        return undefined;
    }
}
function isDeadlineExceeded(cache) {
    if (!cache)
        return false;
    if (Date.now() <= cache.deadline)
        return false;
    cache.truncated = true;
    return true;
}
// Phrases that signal a NEW positional parameter / injection is being added.
const ARITY_ADD_CUE_RE = /\b(?:add(?:s|ing|ed)?|introduc(?:e|es|ing|ed)|new|append(?:s|ing|ed)?|inject(?:s|ing|ed)?)\b[^.\n]{0,60}\b(?:constructor\s+(?:param(?:eter)?|arg(?:ument)?|injection|dependency)|(?:param(?:eter)?|arg(?:ument)?|injection|dependency)\s+to\s+the\s+constructor|\d+(?:st|nd|rd|th)\s+(?:constructor\s+)?(?:param(?:eter)?|arg(?:ument)?)|new\s+(?:injected\s+)?(?:param(?:eter)?|arg(?:ument)?|dependency|service))\b/i;
// Captures a PascalCase service/class symbol named near an arity cue. We look for
// the symbol either as a backticked token or as the subject of a `new X(` form in
// the ticket body.
const PASCAL_SYMBOL_RE = /\b([A-Z][A-Za-z0-9]*(?:Service|Manager|Resolver|Provider|Client|Repository|Store|Gateway|Adapter|Controller|Handler|Factory|Runner|Engine|Auditor|Analyzer|Validator|Collector|Builder))\b/g;
// WS-2 (LOA-1363): phrases that signal a SHAPE change to a `<Name>Schema` symbol —
// a zod field/property/key/member is added, changed, required, extended, or renamed.
// Mirrors the named-cue pattern of ARITY_ADD_CUE_RE.
export const SCHEMA_SHAPE_CUE_RE = /\b(?:add(?:s|ing|ed)?|introduc(?:e|es|ing|ed)|new|chang(?:e|es|ing|ed)|extend(?:s|ing|ed)?|requir(?:e|es|ing|ed)|renam(?:e|es|ing|ed)|tighten(?:s|ing|ed)?)\b[^.\n]{0,60}\b(?:field|property|prop|key|member|column|attribute|shape)\b/i;
// PascalCase zod-schema symbol (e.g. thresholdSchema is lowercase-led by convention,
// but exported schemas are commonly `ThresholdSchema`; we also accept a leading
// lowercase camelCase `<name>Schema` token because zod schemas frequently are).
const SCHEMA_SYMBOL_RE = /\b([A-Za-z][A-Za-z0-9]*Schema)\b/g;
// A new OPTIONAL field (or an explicitly compatible change) is NOT a breaking
// shape change — callers keep working. Skip extraction for such cue lines.
function isOptionalCompatibleChange(line) {
    return /\boptional\b/i.test(line) || /\.optional\s*\(/.test(line) || /\bbackward[- ]?compatible\b/i.test(line);
}
// Extract `<Name>Schema` symbols whose SHAPE the ticket claims to change in a
// breaking way (optional/compatible changes are skipped).
function extractSchemaShapeSymbols(content) {
    const symbols = new Set();
    for (const rawLine of content.split(/\r?\n/)) {
        if (!SCHEMA_SHAPE_CUE_RE.test(rawLine))
            continue;
        if (isOptionalCompatibleChange(rawLine))
            continue;
        SCHEMA_SYMBOL_RE.lastIndex = 0;
        for (const match of rawLine.matchAll(SCHEMA_SYMBOL_RE))
            symbols.add(match[1]);
    }
    return [...symbols];
}
// Factory bridge (LOA-1363): a factory like `makeFacts({...})` shares zero lexical
// tokens with the changed `thresholdSchema`. Resolve the bridge by scanning the
// IN-FENCE declared files for exported function/const names whose declaration body
// references the changed schema symbol; out-of-fence callers of THOSE names are gaps.
function findFactoryBridgeNames(symbol, declaredFiles, repoRoot, cache) {
    const names = new Set();
    const symbolRe = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const exportDeclRe = /\bexport\s+(?:(?:default\s+)?(?:async\s+)?function|(?:abstract\s+)?class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const exportListRe = /\bexport\s*\{([^}]*)\}/g;
    for (const declared of declaredFiles) {
        const abs = path.isAbsolute(declared) ? declared : path.join(repoRoot, declared);
        const body = cache ? readCachedFile(abs, cache) : (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : undefined);
        if (body === undefined || !symbolRe.test(body))
            continue;
        exportDeclRe.lastIndex = 0;
        for (const match of body.matchAll(exportDeclRe))
            names.add(match[1]);
        exportListRe.lastIndex = 0;
        for (const match of body.matchAll(exportListRe)) {
            for (const spec of match[1].split(',')) {
                const exportSpec = spec.trim();
                if (!exportSpec)
                    continue;
                const aliasMatch = exportSpec.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
                if (!aliasMatch)
                    continue;
                names.add(aliasMatch[1]);
                if (aliasMatch[2])
                    names.add(aliasMatch[2]);
            }
        }
    }
    return [...names];
}
// True when a tracked file is declared in-scope by ANY ticket in the bundle (so a
// positional caller there is fixable by a fenced worker and must NOT be flagged).
function isCallerInBundleScope(trackedFile, declaredAll) {
    if (declaredAll.has(trackedFile))
        return true;
    // Exact matches are already handled by the has() check above; only the
    // path-suffix relations remain to be tested here.
    for (const declared of declaredAll) {
        if (trackedFile.endsWith(`/${declared}`) || declared.endsWith(`/${trackedFile}`)) {
            return true;
        }
    }
    return false;
}
// Candidate caller files: tracked specs/factory-builder files plus ordinary
// tracked TS/TSX production callers, capped in deterministic git order.
function callerCandidateFiles(repoRoot, cache) {
    const tracked = cache?.trackedAllFiles ?? gitTrackedFiles(repoRoot);
    if (cache && cache.trackedAllFiles === undefined)
        cache.trackedAllFiles = tracked;
    const candidates = [];
    const seen = new Set();
    for (const file of tracked) {
        const isExistingCandidate = /\.spec\.ts$/.test(file) || /(?:factory|factories|builder)[^/]*\.ts$/i.test(file);
        const isTrackedSource = /\.(?:ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file);
        if ((!isExistingCandidate && !isTrackedSource) || seen.has(file))
            continue;
        seen.add(file);
        candidates.push(file);
        if (candidates.length >= CALLER_CANDIDATE_MAX)
            break;
    }
    return candidates;
}
// Extract candidate symbols whose arity the ticket claims to change.
function extractAritySymbols(content) {
    const symbols = new Set();
    for (const rawLine of content.split(/\r?\n/)) {
        if (!ARITY_ADD_CUE_RE.test(rawLine))
            continue;
        PASCAL_SYMBOL_RE.lastIndex = 0;
        for (const match of rawLine.matchAll(PASCAL_SYMBOL_RE))
            symbols.add(match[1]);
        // Also harvest a `new X(` subject on the cue line even if the suffix list misses it.
        for (const match of rawLine.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*)\s*\(/g))
            symbols.add(match[1]);
    }
    return [...symbols];
}
function readCandidateFile(repoRoot, file, cache) {
    const abs = path.join(repoRoot, file);
    return cache ? readCachedFile(abs, cache) : (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : undefined);
}
function collectArityGapCallers(input) {
    const { symbol, candidates, declaredFiles, repoRoot, cache } = input;
    const callerRe = new RegExp(`\\bnew\\s+${escapeRegExp(symbol)}\\s*\\(`);
    const outOfScopeCallers = [];
    for (const file of candidates) {
        if (isCallerInBundleScope(file, declaredFiles))
            continue;
        if (isDeadlineExceeded(cache)) {
            return { outOfScopeCallers, truncated: true };
        }
        const body = readCandidateFile(repoRoot, file, cache);
        if (body !== undefined && callerRe.test(body))
            outOfScopeCallers.push(file);
    }
    return { outOfScopeCallers, truncated: false };
}
function collectSchemaShapeGapCallers(input) {
    const { symbol, candidates, declaredFiles, repoRoot, cache } = input;
    // Honor the wall-budget BEFORE any file I/O: findFactoryBridgeNames reads
    // declared files, so the deadline must gate ahead of it (the arity scan has no
    // pre-loop I/O, hence its check lives inside the loop).
    if (isDeadlineExceeded(cache)) {
        return { outOfScopeCallers: [], truncated: true };
    }
    const esc = escapeRegExp(symbol);
    const directRe = new RegExp(`\\b${esc}\\s*\\.\\s*(?:parse|safeParse)\\s*\\(|z\\s*\\.\\s*infer\\s*<\\s*typeof\\s+${esc}\\s*>`);
    const bridgeNames = findFactoryBridgeNames(symbol, declaredFiles, repoRoot, cache);
    const bridgeRes = bridgeNames.map((name) => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`));
    const outOfScopeCallers = [];
    for (const file of candidates) {
        if (isCallerInBundleScope(file, declaredFiles))
            continue;
        if (isDeadlineExceeded(cache)) {
            return { outOfScopeCallers, truncated: true };
        }
        const body = readCandidateFile(repoRoot, file, cache);
        if (body === undefined)
            continue;
        if (directRe.test(body) || bridgeRes.some((re) => re.test(body)))
            outOfScopeCallers.push(file);
    }
    return { outOfScopeCallers, truncated: false };
}
export function detectSignatureCallerGaps(input) {
    try {
        const { ticketContents, declaredFiles, repoRoot, cache } = input;
        const candidates = callerCandidateFiles(repoRoot, cache);
        const gaps = [];
        for (const content of ticketContents) {
            for (const symbol of extractAritySymbols(content)) {
                const { outOfScopeCallers, truncated } = collectArityGapCallers({ symbol, candidates, declaredFiles, repoRoot, cache });
                if (truncated) {
                    if (outOfScopeCallers.length > 0)
                        gaps.push({ symbol, kind: 'arity', outOfScopeCallers });
                    return gaps;
                }
                if (outOfScopeCallers.length === 0)
                    continue;
                gaps.push({ symbol, kind: 'arity', outOfScopeCallers });
            }
            // WS-2: schema-shape gaps — direct (`<Schema>.parse(`/`.safeParse(`/`z.infer`)
            // AND factory-mediated (out-of-fence callers of an in-fence factory that
            // references the changed schema). Carried on the same CallerGap[] return.
            for (const symbol of extractSchemaShapeSymbols(content)) {
                const { outOfScopeCallers, truncated } = collectSchemaShapeGapCallers({ symbol, candidates, declaredFiles, repoRoot, cache });
                if (truncated) {
                    if (outOfScopeCallers.length > 0)
                        gaps.push({ symbol, kind: 'schema-shape', outOfScopeCallers });
                    return gaps;
                }
                if (outOfScopeCallers.length === 0)
                    continue;
                gaps.push({ symbol, kind: 'schema-shape', outOfScopeCallers });
            }
        }
        return gaps;
    }
    catch {
        return [];
    }
}
