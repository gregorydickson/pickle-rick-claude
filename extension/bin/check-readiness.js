#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { listRickTicketFiles } from '../services/artifact-validation.js';
import { computeOneHop } from '../services/scope-resolver.js';
import { isRecord } from '../lib/is-record.js';
import { formatLocalDateKey, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import { resolveExtensionDir } from '../services/forward-ref-annotation.js';
import { readDeclaredFiles } from '../services/ticket-declared-files.js';
import { SCOPE_AUTO_EXTEND_MAX, createResolverCache, detectSignatureCallerGaps } from '../services/signature-caller-gap.js';
const SNAPSHOT_FILE = 'readiness_snapshot.json';
const READINESS_MAX_RECYCLE_CYCLES = 3;
const DEFAULT_HISTORY_LIMIT = 10;
// W1c: raised 60_000 -> 120_000. A readiness pre-flight on a large monorepo can
// legitimately spend >60s scanning git-tracked source + declared-dependency `.d.ts`
// files; the old 60s ceiling clipped real resolution and produced a spurious
// indeterminate signal. 120s is the latency ceiling — high enough to finish on big
// repos, low enough that the gate never *feels* hung (it is a batch pre-flight, not an
// interactive prompt). Over-budget is non-blocking: it emits `resolver_indeterminate`
// (warn) and the gate still exits 0 — a checker that can't finish is not a defect.
const DEFAULT_MAX_WALL_MS = 120_000;
const FIND_IMPORTERS_TIMEOUT_MS = 3_000;
const MACHINE_HINT_RE = /\b(\d+(?:\.\d+)?%?|exit\s+\d+|<\s*\d+|>\s*\d+|<=\s*\d+|>=\s*\d+|under\s+\d+|within\s+\d+|exact(?:ly)?|regex|matches?|JSON|field|file exists|writes?|emits?|test|describe\.each|node --test|npm test|tsc|eslint|table|input\/output)\b/i;
const PURE_PROSE_RE = /\b(must|should)\s+(?:be|feel)\s+(?:intuitive|performant|fast|easy|simple|clear|usable|nice|good|robust|reliable)\b/i;
// R-RHFP: lead with a negative lookbehind instead of `\b`. A bare `\b` sits at
// the word boundary INSIDE `.github/...` (between `.` and `g`), so the leading
// `.` of a dotfile path was silently dropped — `.github/workflows/x.yml`
// resolved as `github/workflows/x.yml` and produced a phantom file_path finding.
// The @ in the lookbehind (?<![\w./@-]) deliberately excludes @`-scoped package paths (npm @scope/pkg refs, not in-repo paths).
const PATH_RE = /(?<![\w./@-])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)\b/g;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_$][\w$]*\(\)/g;
// R-RHFP: refinement writes correction notes like
//   *(refined: the PRD cited `old/path.ts` — use `new/path.ts`)*
// into ticket bodies. Paths/symbols quoted inside are the DELIBERATELY-stale
// originals; the resolver must not flag them as unresolved references.
const CORRECTION_NOTE_RE = /\*\(refined:[\s\S]*?\)\*/g;
function stripCorrectionNotes(content) {
    return content.replace(CORRECTION_NOTE_RE, ' ');
}
const ALLOWLIST_FILE_REL = 'extension/.readiness-allowlist.json';
// R-CCR-13: head segments that identify inline code snippets (test-runner
// context or workflow inputs) rather than in-repo contract references.
const SNIPPET_HEAD_SEGMENTS = new Set(['t', 'inputs']);
const GIT_LS_FILES_TIMEOUT_MS = 30_000;
const DOC_EXTENSION_ALLOWLIST = new Set([
    'md',
    'sh',
    'yml',
    'yaml',
    'json',
    'toml',
    'txt',
    'csv',
    'tsv',
    'conf',
    'cfg',
    'ini',
    'env',
    'lock',
    'gitignore',
    'dockerignore',
    'markdown',
]);
function usage() {
    console.error('Usage: node check-readiness.js --session-dir <dir> [--repo-root <dir>] [--manifest <file>] [--machinability-only] [--contract-only] [--history [--last N]] [--skip-readiness <reason>] [--max-wall-ms N]');
    process.exit(1);
}
const SKIP_USAGE_MSG = '--skip-readiness requires a reason argument (e.g. --skip-readiness "bundle pre-validated by refinement team")';
const SKIP_USAGE_EXIT_CODE = 64;
function parseSkipReadiness(argv) {
    const skipIndex = argv.indexOf('--skip-readiness');
    if (skipIndex < 0)
        return undefined;
    const raw = argv[skipIndex + 1];
    if (raw === undefined || raw.startsWith('--') || raw.trim() === '') {
        process.stderr.write(`${SKIP_USAGE_MSG}\n`);
        process.exit(SKIP_USAGE_EXIT_CODE);
    }
    return raw;
}
function parseLast(argv) {
    const lastIndex = argv.indexOf('--last');
    if (lastIndex < 0)
        return DEFAULT_HISTORY_LIMIT;
    const rawLast = argv[lastIndex + 1];
    if (!rawLast || rawLast.startsWith('--'))
        usage();
    const last = Number.parseInt(rawLast, 10);
    if (!Number.isInteger(last) || last < 1)
        usage();
    return last;
}
function parseMaxWallMs(argv) {
    const idx = argv.indexOf('--max-wall-ms');
    if (idx < 0)
        return DEFAULT_MAX_WALL_MS;
    const raw = argv[idx + 1];
    if (!raw || raw.startsWith('--'))
        usage();
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 1)
        usage();
    return value;
}
function parseValueFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx < 0)
        return undefined;
    const value = argv[idx + 1];
    return value && !value.startsWith('--') ? value : undefined;
}
export function parseArgs(argv) {
    const sessionDir = parseValueFlag(argv, '--session-dir');
    if (!sessionDir)
        usage();
    const repoRoot = parseValueFlag(argv, '--repo-root') ?? process.cwd();
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        manifest: parseValueFlag(argv, '--manifest'),
        machinabilityOnly: argv.includes('--machinability-only'),
        contractOnly: argv.includes('--contract-only'),
        history: argv.includes('--history'),
        last: parseLast(argv),
        maxWallMs: parseMaxWallMs(argv),
        skipReadiness: parseSkipReadiness(argv),
    };
}
export function extractAcceptanceCriteria(content) {
    const lines = content.split(/\r?\n/);
    const acs = [];
    let inSection = false;
    for (const line of lines) {
        if (/^##+\s+Acceptance Criteria\b/i.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && /^##+\s+/.test(line))
            break;
        if (!inSection)
            continue;
        const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
        if (match)
            acs.push(match[1]);
    }
    return acs;
}
function acceptanceCriterionVerifyPhase(ac) {
    return /\bverify_pre\b/i.test(ac) ? 'pre' : 'post';
}
export function isMachineCheckable(ac) {
    if (PURE_PROSE_RE.test(ac) && !MACHINE_HINT_RE.test(ac))
        return false;
    return MACHINE_HINT_RE.test(ac) || /\|.+\|/.test(ac) || /`[^`]+`/.test(ac);
}
// R-RTPS-1: runtime deploy paths (tilde-prefix) have no source-tree counterpart.
function isRuntimeTildePath(value) {
    return value.startsWith('~/') || value.startsWith('$HOME/') || value.startsWith('${HOME}/');
}
function isDocExtensionBasename(ref) {
    if (ref.includes('/'))
        return false;
    const lastDot = ref.lastIndexOf('.');
    if (lastDot < 0)
        return false;
    const ext = ref.slice(lastDot + 1).toLowerCase();
    return DOC_EXTENSION_ALLOWLIST.has(ext);
}
// R-RHFP (Finding #64 BUG #3): a dotted all-lowercase literal of 3+ segments
// (e.g. `appraisal.reducto.split_source_mix`) is a telemetry-event NAME, not an
// in-repo symbol contract. Tickets introduce these by design, so symbol
// resolution can never resolve a not-yet-emitted event string — it is a
// guaranteed false `contract` finding. A real symbol contract worth gating on
// is a `Type.member` PascalCase reference; an all-lowercase chain is at most an
// instance-member access the grep resolver cannot meaningfully verify anyway.
function isEventNameLiteral(ref) {
    const parts = ref.replace(/\(\)$/, '').split('.');
    return parts.length >= 3 && parts.every((part) => /^[a-z][a-z0-9_]*$/.test(part));
}
export function extractContractReferences(rawContent) {
    const content = stripCorrectionNotes(rawContent);
    const refs = new Set();
    for (const match of content.matchAll(PATH_RE))
        refs.add(match[0]);
    for (const match of content.matchAll(/`([^`]+)`/g)) {
        const value = match[1].trim();
        if (isRuntimeTildePath(value))
            continue;
        if (PATH_RE.test(value))
            refs.add(value);
        PATH_RE.lastIndex = 0;
        if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value)) {
            if (!SNIPPET_HEAD_SEGMENTS.has(value.split('.')[0]))
                refs.add(value);
        }
        else if (/^[A-Za-z_$][\w$]*\(\)$/.test(value)) {
            refs.add(value);
        }
    }
    for (const match of content.matchAll(SYMBOL_RE))
        refs.add(match[0]);
    return [...refs]
        .filter((ref) => !ref.startsWith('AC-'))
        .filter((ref) => !refs.has(`${ref}()`))
        .filter((ref) => !isDocExtensionBasename(ref))
        .filter((ref) => !isEventNameLiteral(ref))
        .sort();
}
function resolvePathRef(ref, repoRoot, ticket, sessionDir, cache) {
    if (path.isAbsolute(ref) && fs.existsSync(ref))
        return true;
    // AC-B2: a ref prefixed with this repo's own basename (e.g.
    // `pickle-rick-claude/CLAUDE.md`) cannot resolve against the repo-root-relative
    // HEAD path (`CLAUDE.md`) via the bases or the git ls-files suffix-match below.
    // Strip exactly ONE leading segment when it equals path.basename(repoRoot);
    // unrelated leading segments (e.g. `other-repo/x`) are left untouched.
    let normalizedRef = ref;
    const repoPrefix = `${path.basename(repoRoot)}/`;
    if (normalizedRef.startsWith(repoPrefix)) {
        normalizedRef = normalizedRef.slice(repoPrefix.length);
    }
    let workingDir;
    if (ticket.workingDir) {
        workingDir = path.isAbsolute(ticket.workingDir)
            ? ticket.workingDir
            : path.resolve(repoRoot, ticket.workingDir);
    }
    // WS3 (#120 R-ATPR): the extension base is derived through the SHARED resolver so this gate
    // and audit-ticket-bundle resolve an extension-relative ref identically.
    const extensionBase = resolveExtensionDir(repoRoot) ?? path.join(repoRoot, 'extension');
    const bases = [
        workingDir,
        repoRoot,
        extensionBase,
        path.dirname(ticket.file),
        sessionDir,
    ].filter((base) => typeof base === 'string');
    if (bases.some((base) => fs.existsSync(path.resolve(base, normalizedRef))))
        return true;
    // R-RTRC-4: git ls-files suffix-match fallback. Equivalent to
    //   git ls-files | grep -E '/<ref>$|^<ref>$'
    // Catches deep repo paths whose containing dir none of the bases above resolve.
    const tracked = cache?.trackedAllFiles ?? gitTrackedFiles(repoRoot);
    if (cache && cache.trackedAllFiles === undefined)
        cache.trackedAllFiles = tracked;
    const escaped = normalizedRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffixRe = new RegExp(`(?:^|/)${escaped}$`);
    return tracked.some((file) => suffixRe.test(file));
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
// R-RCEX (Finding #65): bounds for the node_modules `.d.ts` resolution scan.
const EXTERNAL_DTS_FILE_CAP = 3_000;
const EXTERNAL_DTS_MAX_BYTES = 512 * 1024;
/**
 * R-RCEX (Finding #65): declared dependency names from the target repo's
 * `package.json` (and the `extension/` sub-package, mirroring `resolvePathRef`
 * bases). `@types/*` stub packages are EXCLUDED here at the call site — a
 * ticket citing a stdlib type is a separate false-positive class handled by
 * `.readiness-allowlist.json`, and the TS lib `.d.ts` files are huge.
 */
function declaredDependencyNames(repoRoot) {
    const names = new Set();
    for (const dir of [repoRoot, path.join(repoRoot, 'extension')]) {
        const pkg = readJsonFile(path.join(dir, 'package.json'));
        if (!isRecord(pkg))
            continue;
        for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            const section = pkg[key];
            if (isRecord(section)) {
                for (const name of Object.keys(section))
                    names.add(name);
            }
        }
    }
    return [...names];
}
function collectDtsFilesUnder(dir, acc) {
    if (acc.length >= EXTERNAL_DTS_FILE_CAP)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (acc.length >= EXTERNAL_DTS_FILE_CAP)
            return;
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules')
                continue; // do not descend into nested deps
            collectDtsFilesUnder(path.join(dir, entry.name), acc);
        }
        else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
            acc.push(path.join(dir, entry.name));
        }
    }
}
function collectExternalDtsFiles(repoRoot) {
    const files = [];
    const deps = declaredDependencyNames(repoRoot).filter((dep) => !dep.startsWith('@types/'));
    const moduleRoots = [
        path.join(repoRoot, 'node_modules'),
        path.join(repoRoot, 'extension', 'node_modules'),
    ].filter((root) => fs.existsSync(root));
    for (const root of moduleRoots) {
        for (const dep of deps) {
            if (files.length >= EXTERNAL_DTS_FILE_CAP)
                return files;
            const depDir = path.join(root, dep); // path.join handles @scope/pkg
            if (fs.existsSync(depDir))
                collectDtsFilesUnder(depDir, files);
        }
    }
    return files;
}
/**
 * R-RCEX (Finding #65): after in-repo resolution misses, grep-match the ref's
 * parts against the declared dependencies' `.d.ts` surface — same
 * all-parts-in-one-file semantics as the in-repo resolver. A ticket that
 * legitimately uses a third-party SDK symbol no longer trips a `contract`
 * finding. Oversized `.d.ts` files (TS lib stubs) are skipped to bound memory.
 */
function resolveExternalSymbolRef(partPatterns, repoRoot, cache) {
    if (cache.externalDtsFiles === undefined) {
        cache.externalDtsFiles = collectExternalDtsFiles(repoRoot);
    }
    return cache.externalDtsFiles.some((file) => {
        if (cache.fileContents.get(file) === undefined) {
            try {
                if (fs.statSync(file).size > EXTERNAL_DTS_MAX_BYTES)
                    return false;
            }
            catch {
                return false;
            }
        }
        const content = readCachedFile(file, cache);
        if (content === undefined)
            return false;
        return partPatterns.every((pattern) => pattern.test(content));
    });
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
function resolveSymbolRef(ref, repoRoot, cache) {
    const normalized = ref.replace(/\(\)$/, '');
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length === 0)
        return false;
    const partPatterns = parts.map((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    const candidates = cache.trackedSourceFiles.filter((file) => {
        const content = readCachedFile(path.join(repoRoot, file), cache);
        if (content === undefined)
            return false;
        return partPatterns.every((pattern) => pattern.test(content));
    });
    if (candidates.length === 0)
        return resolveExternalSymbolRef(partPatterns, repoRoot, cache);
    if (candidates.length === 1)
        return true;
    try {
        computeOneHop(candidates.slice(0, 1), repoRoot, { findImportersTimeoutMs: FIND_IMPORTERS_TIMEOUT_MS });
        return true;
    }
    catch {
        return false;
    }
}
function findMachinabilityFindings(ticketFile, content) {
    const findings = [];
    for (const ac of extractAcceptanceCriteria(content)) {
        if (acceptanceCriterionVerifyPhase(ac) === 'post')
            continue;
        if (!isMachineCheckable(ac)) {
            findings.push({
                ticket: ticketFile,
                kind: 'machinability',
                analyst: 'gaps',
                message: 'Acceptance criterion is not machine-checkable',
                detail: ac,
            });
        }
    }
    return findings;
}
// R-RCFF (Step 1+3): a ref matching the bundle creation index is forward-created
// Genuinely-unresolvable refs (absent at HEAD) keep kind:'contract'.
function unresolvedContractFinding(ticketFile, ref) {
    return {
        ticket: ticketFile,
        kind: 'contract',
        analyst: 'codebase',
        message: 'Referenced contract does not resolve',
        detail: ref,
    };
}
export function findReadinessFindings(ticketFile, repoRoot, opts) {
    const content = fs.readFileSync(ticketFile, 'utf-8');
    const findings = [];
    if (opts.checkMachinability)
        findings.push(...findMachinabilityFindings(ticketFile, content));
    if (opts.checkContracts) {
        const allowlist = opts.allowlist ?? opts.cache?.allowlist ?? new Set();
        const cache = opts.cache ?? createResolverCache(repoRoot, opts.maxWallMs ?? DEFAULT_MAX_WALL_MS, allowlist);
        for (const ref of extractContractReferences(content)) {
            if (ref.includes('/'))
                continue;
            if (allowlist.has(ref))
                continue;
            if (Date.now() > cache.deadline) {
                cache.truncated = true;
                findings.push({
                    ticket: ticketFile,
                    kind: 'performance',
                    analyst: 'codebase',
                    message: 'Contract resolution wall budget exceeded; remaining refs were not checked',
                    detail: ref,
                });
                break;
            }
            if (!resolveSymbolRef(ref, repoRoot, cache)) {
                findings.push(unresolvedContractFinding(ticketFile, ref));
            }
        }
    }
    return findings;
}
/**
 * CGH-3 (61d02c4e): count backticked path/symbol refs in arbitrary text that FAIL the same
 * resolution used to produce `path_not_verified` / `contract` findings. Reuses the canonical
 * extraction (`extractContractReferences`) and resolvers (`resolvePathRef`/`resolveSymbolRef`)
 * — NO duplicated regex. Path-shaped refs (`/`) go through `resolvePathRef`; symbol-shaped refs
 * through `resolveSymbolRef`. Consumed by `codegraph-efficacy-probe.ts` to score hallucinated
 * references in a captured worker diff.
 */
export function countUnresolvedReferences(text, repoRoot) {
    const cache = createResolverCache(repoRoot, DEFAULT_MAX_WALL_MS);
    const ticket = {
        file: path.join(repoRoot, '__codegraph_efficacy_probe_synthetic__.md'),
        id: '__probe__',
        mappedRequirements: [],
        acIds: [],
        dependencies: [],
    };
    let count = 0;
    for (const ref of extractContractReferences(text)) {
        if (cache.allowlist.has(ref))
            continue;
        const resolved = ref.includes('/')
            ? resolvePathRef(ref, repoRoot, ticket, repoRoot, cache)
            : resolveSymbolRef(ref, repoRoot, cache);
        if (!resolved)
            count += 1;
    }
    return count;
}
function parseFrontmatter(content) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    return match ? match[1] : '';
}
function readScalar(frontmatter, key) {
    const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
    if (!match)
        return undefined;
    const value = match[1].trim();
    if (value === '[]')
        return undefined;
    return value.replace(/^['"]|['"]$/g, '');
}
function readStringArray(frontmatter, key) {
    const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(frontmatter);
    if (inline) {
        return inline[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    const lines = frontmatter.split(/\r?\n/);
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
    if (index < 0)
        return [];
    const values = [];
    for (let i = index + 1; i < lines.length; i += 1) {
        const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
        if (!match)
            break;
        values.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
    return values;
}
function unquoteYamlish(value) {
    return value.trim().replace(/^['"]|['"]$/g, '');
}
function readNestedStringArray(frontmatter, parentKey, childKey) {
    const lines = frontmatter.split(/\r?\n/);
    const parentIndex = lines.findIndex((line) => new RegExp(`^${parentKey}:\\s*$`).test(line));
    if (parentIndex < 0)
        return [];
    const values = [];
    for (let i = parentIndex + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\S/.test(line))
            break;
        if (!new RegExp(`^\\s+${childKey}:\\s*$`).test(line))
            continue;
        for (let j = i + 1; j < lines.length; j += 1) {
            const item = lines[j];
            if (/^\s{2}\S/.test(item) && !/^\s{4,}-\s+/.test(item))
                break;
            const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(item);
            if (match)
                values.push(unquoteYamlish(match[1]));
        }
        break;
    }
    return values;
}
function dependencyRefs(content, frontmatter) {
    const refs = new Map();
    for (const dep of [...readStringArray(frontmatter, 'depends_on'), ...readStringArray(frontmatter, 'dependencies')]) {
        const external = /\bexternal\b/i.test(dep) || dep.startsWith('external:');
        refs.set(dep.replace(/^external:/, '').trim(), external);
    }
    for (const match of content.matchAll(/title:\s*["']?Depends on:\s*([^"'\n]+)["']?/gi)) {
        const raw = match[1].trim();
        const ref = raw.split(/\s+[—-]\s+|\s+\(/)[0]?.trim();
        if (!ref)
            continue;
        refs.set(ref, /\bexternal\b/i.test(raw));
    }
    return [...refs].map(([ref, external]) => ({ ref, external }));
}
function ticketInfo(ticketFile) {
    const content = fs.readFileSync(ticketFile, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const id = readScalar(frontmatter, 'id') ?? path.basename(path.dirname(ticketFile));
    const acIds = [
        ...readStringArray(frontmatter, 'ac_ids'),
        ...extractAcceptanceCriteria(content)
            .flatMap((ac) => [...ac.matchAll(/\b(?:AC-[A-Za-z0-9-]+|P\d+\.\d+|R\d+|T\d+)\b/g)].map((match) => match[0])),
    ];
    return {
        file: ticketFile,
        id,
        key: readScalar(frontmatter, 'key'),
        workingDir: readScalar(frontmatter, 'working_dir'),
        sourcePrd: readScalar(frontmatter, 'source_prd'),
        sourceSection: readScalar(frontmatter, 'source_section'),
        mappedRequirements: readStringArray(frontmatter, 'mapped_requirements'),
        acIds: [...new Set(acIds)].sort(),
        dependencies: dependencyRefs(content, frontmatter),
    };
}
function readJsonFile(file) {
    if (!file || !fs.existsSync(file))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
/**
 * R-RTRC-5: Load `extension/.readiness-allowlist.json` from repoRoot. Each
 * entry is `{ ref: string, source: string, kind?: 'path'|'symbol'|'both' }`.
 * Entries lacking a non-empty `source` field are dropped at load time and
 * blocked by `extension/scripts/audit-readiness-allowlist.sh` (lint).
 */
export function loadReadinessAllowlist(repoRoot) {
    const candidates = [
        path.join(repoRoot, ALLOWLIST_FILE_REL),
        path.join(repoRoot, 'extension', '.readiness-allowlist.json'),
        path.join(repoRoot, '.readiness-allowlist.json'),
    ];
    const allowlistPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!allowlistPath)
        return new Set();
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    }
    catch {
        return new Set();
    }
    if (!Array.isArray(parsed))
        return new Set();
    const refs = new Set();
    for (const entry of parsed) {
        if (!isRecord(entry))
            continue;
        const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
        const source = typeof entry.source === 'string' ? entry.source.trim() : '';
        if (!ref || !source)
            continue; // R-RTRC-5: source field is mandatory.
        refs.add(ref);
    }
    return refs;
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.length > 0);
}
function resolvePeerPrdPath(parentPrdPath, peerPath, repoRoot) {
    if (path.isAbsolute(peerPath) && fs.existsSync(peerPath))
        return peerPath;
    const candidates = [
        path.resolve(path.dirname(parentPrdPath), peerPath),
        path.resolve(repoRoot, peerPath),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}
function requirementsFromPrd(filePath, sourcePrd, idPattern = /\bAC-[A-Za-z0-9-]+\b/g) {
    const requirements = [];
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    let section = '';
    for (const line of lines) {
        const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
        if (heading)
            section = heading[1].trim();
        for (const match of line.matchAll(idPattern)) {
            requirements.push({ sourcePrd, sourceSection: section, requirementId: match[0] });
        }
    }
    return requirements;
}
function sourceRequirementsFromParentPrd(parentPrdPath, repoRoot) {
    if (!parentPrdPath || !fs.existsSync(parentPrdPath))
        return [];
    const parentContent = fs.readFileSync(parentPrdPath, 'utf-8');
    const peerPaths = readNestedStringArray(parseFrontmatter(parentContent), 'peer_prds', 'deferred');
    const requirements = requirementsFromPrd(parentPrdPath, path.relative(repoRoot, parentPrdPath) || path.basename(parentPrdPath), /\bAC-DR-[A-Za-z0-9-]+\b/g);
    for (const peerPath of peerPaths) {
        const resolved = resolvePeerPrdPath(parentPrdPath, peerPath, repoRoot);
        if (!resolved)
            continue;
        requirements.push(...requirementsFromPrd(resolved, peerPath));
    }
    return requirements;
}
function uniqueStrings(values) {
    return [...new Set(values.filter((value) => value.trim() !== ''))].sort();
}
function resolveManifestPrdPath(manifest, sessionDir, repoRoot) {
    if (!isRecord(manifest) || typeof manifest.prd_path !== 'string' || manifest.prd_path.trim() === '')
        return undefined;
    const prdPath = manifest.prd_path;
    if (path.isAbsolute(prdPath))
        return prdPath;
    const candidates = [
        path.resolve(repoRoot, prdPath),
        path.resolve(sessionDir, prdPath),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
function manifestTickets(manifest) {
    if (!isRecord(manifest) || !Array.isArray(manifest.tickets))
        return [];
    return manifest.tickets.filter(isRecord);
}
function manifestTicketFor(ticket, manifest) {
    return manifestTickets(manifest).find((entry) => entry.id === ticket.id || entry.key === ticket.key);
}
function sourceRequirementIndex(requirements) {
    const index = new Map();
    for (const requirement of requirements) {
        const existing = index.get(requirement.requirementId) ?? [];
        existing.push(requirement);
        index.set(requirement.requirementId, existing);
    }
    return index;
}
function enrichTickets(tickets, manifest, sourceRequirements) {
    const byRequirement = sourceRequirementIndex(sourceRequirements);
    return tickets.map((ticket) => {
        const manifestTicket = manifestTicketFor(ticket, manifest);
        const mappedRequirements = uniqueStrings([
            ...ticket.mappedRequirements,
            ...stringArray(manifestTicket?.mapped_requirements),
            ...stringArray(manifestTicket?.requirements),
            ...stringArray(manifestTicket?.ac_ids),
        ]);
        const acIds = uniqueStrings([...ticket.acIds, ...mappedRequirements]);
        const matches = acIds.flatMap((id) => byRequirement.get(id) ?? []);
        const sourcePrds = uniqueStrings(matches.map((match) => match.sourcePrd));
        const sourceSections = uniqueStrings(matches.map((match) => match.sourceSection));
        const inferredSourcePrd = sourcePrds.join(', ') || undefined;
        const inferredSourceSection = sourceSections.join(', ') || undefined;
        return {
            ...ticket,
            sourcePrd: ticket.sourcePrd ?? (typeof manifestTicket?.source_prd === 'string' ? manifestTicket.source_prd : undefined) ?? inferredSourcePrd,
            sourceSection: ticket.sourceSection ?? (typeof manifestTicket?.source_section === 'string' ? manifestTicket.source_section : undefined) ?? inferredSourceSection,
            mappedRequirements,
            acIds,
        };
    });
}
function manifestRequirementIds(manifest, sourceRequirements = []) {
    const ids = new Set();
    for (const req of sourceRequirements)
        ids.add(req.requirementId);
    if (!isRecord(manifest))
        return [...ids].sort();
    for (const req of stringArray(manifest.requirements))
        ids.add(req);
    if (isRecord(manifest.prd_requirements)) {
        for (const value of Object.values(manifest.prd_requirements)) {
            for (const req of stringArray(value))
                ids.add(req);
        }
    }
    for (const ticket of manifestTickets(manifest)) {
        for (const req of stringArray(ticket.requirements))
            ids.add(req);
    }
    return [...ids].sort();
}
function manifestRefs(manifest, tickets) {
    const refs = new Set(tickets.flatMap((ticket) => [ticket.id, ticket.key].filter((value) => Boolean(value))));
    for (const ticket of manifestTickets(manifest)) {
        if (typeof ticket.id === 'string')
            refs.add(ticket.id);
        if (typeof ticket.key === 'string')
            refs.add(ticket.key);
    }
    return refs;
}
function ticketRequirementIds(manifest, tickets) {
    const ids = new Set(tickets.flatMap((ticket) => [...ticket.acIds, ...ticket.mappedRequirements]));
    for (const ticket of manifestTickets(manifest)) {
        for (const ac of stringArray(ticket.ac_ids))
            ids.add(ac);
        for (const req of stringArray(ticket.requirements))
            ids.add(req);
    }
    return ids;
}
function findPrdMapFindings(tickets, manifest, sourceRequirements) {
    const mapped = ticketRequirementIds(manifest, tickets);
    return manifestRequirementIds(manifest, sourceRequirements)
        .filter((requirement) => !mapped.has(requirement))
        .map((requirement) => ({
        ticket: 'manifest',
        kind: 'prd_map',
        analyst: 'gaps',
        message: 'PRD requirement is not mapped to any ticket',
        detail: requirement,
    }));
}
function findPathFindings(ticket, repoRoot, sessionDir, cache) {
    // R-RHFP: drop `*(refined: ...)*` correction notes so stale old paths
    // quoted inside them are not flagged as unresolved.
    const content = stripCorrectionNotes(fs.readFileSync(ticket.file, 'utf-8'));
    const allowlist = cache?.allowlist ?? new Set();
    const refs = new Set();
    for (const match of content.matchAll(PATH_RE))
        refs.add(match[0]);
    // A `file_path` ref hard-halts iff it suffix-matches no HEAD path (a true
    // phantom) — via R-RTRC-4's repo-prefix strip + git ls-files `(?:^|/)<ref>$`.
    // The `allowlist` (R-RTRC-5) filter below is a distinct suppression surface.
    return [...refs].sort()
        .filter((ref) => !allowlist.has(ref))
        .filter((ref) => !resolvePathRef(ref, repoRoot, ticket, sessionDir, cache))
        .map((ref) => ({
        ticket: ticket.file,
        kind: 'file_path',
        analyst: 'codebase',
        message: 'Referenced ticket file path does not resolve',
        detail: ref,
    }));
}
function findDependencyFindings(ticket, refs) {
    return ticket.dependencies
        .filter((dep) => !dep.external && !refs.has(dep.ref))
        .map((dep) => ({
        ticket: ticket.file,
        kind: 'dependency',
        analyst: 'risk',
        message: 'Ticket dependency is not in the manifest and is not marked external',
        detail: dep.ref,
    }));
}
function displayTicketRef(sessionDir, ticket) {
    return path.isAbsolute(ticket) ? path.relative(sessionDir, ticket) : ticket;
}
function readState(sessionDir) {
    const statePath = path.join(sessionDir, 'state.json');
    const recoveredState = readRecoverableJsonObject(statePath);
    if (!fs.existsSync(statePath) && !recoveredState)
        return {};
    try {
        return new StateManager().read(statePath);
    }
    catch {
        return {};
    }
}
function writeState(sessionDir, state) {
    const statePath = path.join(sessionDir, 'state.json');
    const recoveredState = readRecoverableJsonObject(statePath);
    if (!fs.existsSync(statePath) && !recoveredState)
        return;
    const sm = new StateManager();
    sm.update(statePath, (current) => {
        Object.assign(current, state);
    });
}
function readinessCycleHistory(state) {
    const history = state.readiness?.cycle_history;
    if (!Array.isArray(history))
        return [];
    return history.filter(isRecord).map((entry, index) => ({
        cycle: typeof entry.cycle === 'number' && Number.isFinite(entry.cycle) ? entry.cycle : index + 1,
        status: typeof entry.status === 'string' ? entry.status : '',
        suggested_analyst: typeof entry.suggested_analyst === 'string' ? entry.suggested_analyst : null,
        user_action: typeof entry.user_action === 'string' ? entry.user_action : null,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    }));
}
function readinessCycleCount(sessionDir, state) {
    if (Array.isArray(state.readiness?.cycle_history))
        return state.readiness.cycle_history.length;
    return fs.readdirSync(sessionDir).filter((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)).length;
}
function appendReadinessCycle(sessionDir, state, findings, escalated) {
    if (escalated)
        return;
    const existing = readinessCycleHistory(state);
    if (existing.length >= READINESS_MAX_RECYCLE_CYCLES)
        return;
    const next = {
        cycle: existing.length + 1,
        status: 'failed',
        suggested_analyst: findings[0]?.analyst ?? null,
        user_action: null,
        timestamp: new Date().toISOString(),
    };
    state.readiness = {
        ...(isRecord(state.readiness) ? state.readiness : {}),
        cycle_history: [...existing, next].slice(0, READINESS_MAX_RECYCLE_CYCLES),
    };
    writeState(sessionDir, state);
}
// AC-B4: max suppressed-finding signatures carried in one
// `readiness_false_positive_suppressed` payload (keeps the event bounded).
const READINESS_FALSE_POSITIVE_SUPPRESSED_CAP = 50;
function findingSignature(finding) {
    return `${finding.kind}:${finding.ticket}:${finding.detail}`;
}
function readPriorFindingSignatures(state) {
    const readiness = isRecord(state.readiness) ? state.readiness : undefined;
    const prior = readiness?.prior_finding_signatures;
    if (!Array.isArray(prior))
        return [];
    return prior.filter((s) => typeof s === 'string');
}
// AC-B4 (observability ONLY — never throws, never affects exitCode): when a
// blocking finding present in the PRIOR run is ABSENT in the current run, emit
// one `readiness_false_positive_suppressed` event with the suppressed count, then
// persist the current run's signatures for the next comparison.
function persistFindingSignaturesAndEmit(sessionDir, state, blockingFindings) {
    try {
        const current = blockingFindings.map(findingSignature);
        const currentSet = new Set(current);
        const prior = readPriorFindingSignatures(state);
        const suppressed = prior.filter((sig) => !currentSet.has(sig));
        if (suppressed.length > 0) {
            logActivity({
                event: 'readiness_false_positive_suppressed',
                source: 'pickle',
                session: path.basename(sessionDir),
                gate_payload: {
                    suppressed_count: suppressed.length,
                    suppressed: suppressed.slice(0, READINESS_FALSE_POSITIVE_SUPPRESSED_CAP),
                },
            });
        }
        state.readiness = {
            ...(isRecord(state.readiness) ? state.readiness : {}),
            cycle_history: readinessCycleHistory(state),
            prior_finding_signatures: current,
        };
        writeState(sessionDir, state);
    }
    catch {
        // observability only — a comparison/persist failure must never block readiness
    }
}
function hashFile(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readSnapshot(sessionDir) {
    const file = path.join(sessionDir, SNAPSHOT_FILE);
    if (!fs.existsSync(file))
        return undefined;
    try {
        const parsed = readRecoverableJsonObject(file);
        return parsed && typeof parsed.hashes === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function writeSnapshot(sessionDir, ticketFiles, ticketsVersion) {
    const snapshot = {
        ticketsVersion,
        hashes: Object.fromEntries(ticketFiles.map((file) => [path.relative(sessionDir, file), hashFile(file)])),
    };
    writeStateFile(path.join(sessionDir, SNAPSHOT_FILE), snapshot);
}
function getTicketsVersion(state) {
    return typeof state.tickets_version === 'number' ? state.tickets_version : undefined;
}
function selectTicketFiles(sessionDir, state) {
    const allFiles = listRickTicketFiles(sessionDir);
    const snapshot = readSnapshot(sessionDir);
    const ticketsVersion = getTicketsVersion(state);
    const hasCorrection = Array.isArray(state.activity) && state.activity.some((entry) => entry.event === 'course_corrected');
    const delta = Boolean(snapshot && ticketsVersion !== undefined && snapshot.ticketsVersion !== ticketsVersion && hasCorrection);
    if (!delta || !snapshot)
        return { files: allFiles, delta: false };
    return {
        files: allFiles.filter((file) => snapshot.hashes[path.relative(sessionDir, file)] !== hashFile(file)),
        delta: true,
    };
}
function writeReport(sessionDir, tickets, findings, escalation) {
    const date = formatLocalDateKey(new Date());
    const filename = escalation ? `readiness_escalation_${date}.md` : `readiness_${date}.md`;
    const reportPath = path.join(sessionDir, filename);
    const prdMapRows = tickets.map((ticket) => `| ${ticket.id} | ${ticket.key ?? ''} | ${ticket.sourcePrd ?? ''} | ${ticket.sourceSection ?? ''} | ${uniqueStrings([...ticket.acIds, ...ticket.mappedRequirements]).join(', ')} |`);
    const acRows = tickets.flatMap((ticket) => extractAcceptanceCriteria(fs.readFileSync(ticket.file, 'utf-8')).map((ac) => {
        const status = acceptanceCriterionVerifyPhase(ac) === 'post' ? 'SKIP_POST' : isMachineCheckable(ac) ? 'PASS' : 'FAIL';
        return `| ${path.relative(sessionDir, ticket.file)} | ${status} | ${ac.replace(/\|/g, '\\|')} |`;
    }));
    const contractRows = findings
        .filter((finding) => finding.kind === 'contract')
        .map((finding) => `| ${displayTicketRef(sessionDir, finding.ticket)} | FAIL | ${finding.detail} | ${finding.analyst} |`);
    const lines = [
        `# ${escalation ? 'Readiness Escalation' : 'Readiness Failure'}`,
        '',
        `Date: ${date}`,
        '',
        '## PRD-ticket map',
        '',
        '| Ticket | Key | Source PRD | Source section | Mapped requirements |',
        '|---|---|---|---|---|',
        ...prdMapRows,
        ...findings.filter((finding) => finding.kind === 'prd_map').map((finding) => `| manifest |  |  |  | MISSING: ${finding.detail} |`),
        '',
        '## AC verifiability matrix',
        '',
        '| Ticket | Status | Criterion |',
        '|---|---|---|',
        ...acRows,
        '',
        '## Contract resolution table',
        '',
        '| Ticket | Status | Reference | Suggested analyst |',
        '|---|---|---|---|',
        ...(contractRows.length > 0 ? contractRows : ['| all | PASS |  |  |']),
        '',
        '## Findings',
        ...findings.map((finding) => [
            `- **${finding.kind}** in \`${displayTicketRef(sessionDir, finding.ticket)}\``,
            `  - suggested_analyst: ${finding.analyst}`,
            `  - ${finding.message}: \`${finding.detail}\``,
        ].join('\n')),
        '',
    ];
    fs.writeFileSync(reportPath, lines.join('\n'));
    return reportPath;
}
// W1c: name the resolution phase the over-budget gate ran, for the indeterminate event.
function resolverPhase(checkContracts, checkMachinability) {
    if (checkContracts && !checkMachinability)
        return 'contract';
    if (checkMachinability && !checkContracts)
        return 'machinability';
    return 'mixed';
}
function maybeEmitResolverIndeterminate(input) {
    if (!input.truncated)
        return;
    logActivity({
        event: 'resolver_indeterminate',
        source: 'pickle',
        session: path.basename(input.sessionDir),
        gate_payload: {
            wall_ms: input.wallMs,
            budget_ms: input.budgetMs,
            phase: resolverPhase(input.checkContracts, input.checkMachinability),
        },
    });
}
// SCOPE_AUTO_EXTEND_MAX (cap for the auto_extend_signature_callers flag) is imported
// from ../services/signature-caller-gap.js — the single definition shared with the
// build-phase auto-extension in pipeline-runner.ts.
function collectAllDeclared(sigTickets) {
    const all = new Set();
    for (const t of sigTickets)
        for (const f of t.declaredFiles)
            all.add(f);
    return all;
}
function buildGapFinding(ticketFile, gap) {
    const base = gap.kind === 'schema-shape'
        ? `Schema-shape change to '${gap.symbol}' has out-of-scope consumer(s) (.parse/.safeParse/factory) ` +
            'OUTSIDE the bundle scope fence; no fenced worker can update them, so tsc may stay RED ' +
            '(heuristic markdown+grep detection, not a type-aware diff; verify and extend or rescope the callers)'
        : `Arity change to '${gap.symbol}' has positional caller(s) OUTSIDE the bundle scope fence; ` +
            'no fenced worker can update them, so tsc may stay RED (heuristic markdown+grep detection, ' +
            'not a type-aware diff; verify and extend or rescope the callers)';
    const suffix = ` (advisory — never blocks readiness) — To resolve: (1) co-scope the caller by adding it to ## Files to modify in the ticket, ` +
        `or (2) set scope.auto_extend_signature_callers: true in scope.json (build-phase auto-extension absorbs ≤${SCOPE_AUTO_EXTEND_MAX} callers)`;
    return {
        ticket: ticketFile,
        kind: 'signature_caller_gap',
        analyst: 'risk',
        message: base + suffix,
        detail: `${gap.symbol} -> ${gap.outOfScopeCallers.join(', ')}`,
    };
}
export function findSignatureChangeCallerGapFindings(sigTickets, repoRoot, cache) {
    const declaredAll = collectAllDeclared(sigTickets);
    const findings = [];
    for (const ticket of sigTickets) {
        let content;
        try {
            content = fs.readFileSync(ticket.file, 'utf-8');
        }
        catch {
            continue;
        }
        const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles: declaredAll, repoRoot, cache });
        for (const gap of gaps) {
            findings.push(buildGapFinding(ticket.file, gap));
        }
    }
    return findings;
}
export function runReadiness(args) {
    const started = Date.now();
    const state = readState(args.sessionDir);
    const selected = selectTicketFiles(args.sessionDir, state);
    const checkMachinability = args.machinabilityOnly || !args.contractOnly;
    const checkContracts = args.contractOnly || !args.machinabilityOnly;
    const manifestPath = args.manifest ? path.resolve(args.sessionDir, args.manifest) : path.join(args.sessionDir, 'decomposition_manifest.json');
    const manifest = readJsonFile(fs.existsSync(manifestPath) ? manifestPath : args.manifest);
    const sourceRequirements = sourceRequirementsFromParentPrd(resolveManifestPrdPath(manifest, args.sessionDir, args.repoRoot), args.repoRoot);
    const tickets = enrichTickets(selected.files.map(ticketInfo), manifest, sourceRequirements);
    const refs = manifestRefs(manifest, tickets);
    // R-RTRC-5: extension/.readiness-allowlist.json — long-tail false positives
    // (stdlib, external APIs) listed with `source:` justification short-circuit
    // both path and symbol resolution.
    const allowlist = loadReadinessAllowlist(args.repoRoot);
    const resolverCache = checkContracts || !args.machinabilityOnly
        ? createResolverCache(args.repoRoot, args.maxWallMs, allowlist)
        : undefined;
    const pathCache = resolverCache ?? createResolverCache(args.repoRoot, args.maxWallMs, allowlist);
    // R-SIGF (WS-1, demoted to advisory per W5b — see the ADVISORY CONTRACT note above):
    // signature-change-caller-gap scan; findings surface in the report, never block.
    const sigTickets = selected.files.map((file) => ({
        file,
        declaredFiles: new Set(readDeclaredFiles(fs.readFileSync(file, 'utf-8'))),
    }));
    const findings = [
        ...findPrdMapFindings(tickets, manifest, sourceRequirements),
        ...tickets.flatMap((ticket) => findPathFindings(ticket, args.repoRoot, args.sessionDir, pathCache)),
        ...tickets.flatMap((ticket) => findDependencyFindings(ticket, refs)),
        ...selected.files.flatMap((file) => findReadinessFindings(file, args.repoRoot, { checkMachinability, checkContracts, cache: resolverCache, maxWallMs: args.maxWallMs, allowlist })),
        ...findSignatureChangeCallerGapFindings(sigTickets, args.repoRoot, pathCache),
    ];
    const ticketsVersion = getTicketsVersion(state);
    // W1c (AC-W1c-1): when the contract/symbol resolver exhausts its wall budget it
    // sets `cache.truncated` and self-reports a `kind:'performance'` finding (which the
    // R-RHFP filter below already keeps out of the blocking set). Emit a NAMED, observable
    // `resolver_indeterminate` (warn) event so the over-budget condition is auditable —
    // never a `wall_budget_exceeded` finding that halts the bundle. This is purely
    // additive: the exit-0 path is already taken via `blockingFindings`.
    maybeEmitResolverIndeterminate({
        truncated: (resolverCache?.truncated ?? false) || pathCache.truncated,
        sessionDir: args.sessionDir,
        wallMs: Date.now() - started,
        budgetMs: args.maxWallMs,
        checkContracts,
        checkMachinability,
    });
    // R-RHFP (Finding #64 BUG #1): `kind:'performance'` findings are the checker
    // reporting its OWN incompleteness (contract-resolution wall budget exceeded
    // on a large/slow target repo), not a ticket defect. They stay in `findings`
    // — surfaced in the report and JSON output as a coverage-gap signal — but are
    // excluded from the blocking set that drives `status:fail`. A gate that fails
    // because the checker ran out of time is not a gate.
    // R-RCFF (Step 3): forward-created refs carry kind:'advisory' — they appear in
    // `findings`/the report as a coverage signal but, like kind:'performance', are
    // excluded from the blocking set that drives `status:fail` and the exit code.
    // W5b (2026-07-10): kind:'signature_caller_gap' joins the advisory set — the blocking
    // arm ran 240x over its skip-flag budget (725 uses/10d vs 3); the finding still
    // surfaces, the build-phase scope auto-extension still absorbs real gaps.
    const blockingFindings = findings.filter((finding) => finding.kind !== 'performance' && finding.kind !== 'advisory' && finding.kind !== 'signature_caller_gap');
    // AC-B4: NON-BLOCKING readiness false-positive counter. Compare this run's
    // blocking findings against the prior run's persisted signatures and emit
    // `readiness_false_positive_suppressed` for any prior finding now absent. This
    // is pure observability — it runs on BOTH the pass and fail paths and never
    // alters the exit code.
    persistFindingSignaturesAndEmit(args.sessionDir, state, blockingFindings);
    if (blockingFindings.length === 0) {
        writeSnapshot(args.sessionDir, listRickTicketFiles(args.sessionDir), ticketsVersion);
        return { exitCode: 0, findings, delta: selected.delta, elapsed_ms: Date.now() - started };
    }
    const escalation = readinessCycleCount(args.sessionDir, state) >= READINESS_MAX_RECYCLE_CYCLES;
    const reportPath = writeReport(args.sessionDir, tickets, findings, escalation);
    appendReadinessCycle(args.sessionDir, state, blockingFindings, escalation);
    if (selected.delta) {
        logActivity({
            event: 'readiness_failed_post_correction',
            source: 'pickle',
            session: path.basename(args.sessionDir),
            gate_payload: { findings: findings.length, report: reportPath },
        });
    }
    return { exitCode: 2, findings, reportPath, delta: selected.delta, elapsed_ms: Date.now() - started };
}
export function runHistory(args) {
    const history = readinessCycleHistory(readState(args.sessionDir)).slice(-args.last);
    const rows = history.map((entry) => [
        entry.cycle,
        entry.status || '',
        entry.suggested_analyst ?? '',
        entry.user_action ?? '',
        entry.timestamp || '',
    ]);
    return [
        '| Cycle | Status | Suggested analyst | User action | Timestamp |',
        '|---:|---|---|---|---|',
        ...(rows.length > 0 ? rows.map((row) => `| ${row.join(' | ')} |`) : ['|  |  |  |  |  |']),
        '',
    ].join('\n');
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    try {
        if (args.history) {
            process.stdout.write(runHistory(args));
            process.exit(0);
        }
        if (args.skipReadiness !== undefined) {
            const reason = args.skipReadiness;
            const timestamp = new Date().toISOString();
            logActivity({
                event: 'readiness_skipped',
                source: 'pickle',
                session: path.basename(args.sessionDir),
                gate_payload: { reason, timestamp },
            });
            if (/manifest-bundle/i.test(reason)) {
                logActivity({
                    event: 'readiness_skipped_for_manifest',
                    source: 'pickle',
                    session: path.basename(args.sessionDir),
                    gate_payload: { reason, timestamp },
                });
            }
            process.stdout.write(`${JSON.stringify({ status: 'skipped', reason, elapsed_ms: 0 })}\n`);
            process.exit(0);
        }
        const result = runReadiness(args);
        process.stdout.write(`${JSON.stringify({
            status: result.exitCode === 0 ? 'pass' : 'fail',
            findings: result.findings,
            elapsed_ms: result.elapsed_ms,
            report: result.reportPath,
            delta: result.delta,
        })}\n`);
        if (result.reportPath)
            process.stderr.write(`readiness failed: ${result.reportPath}\n`);
        process.exit(result.exitCode);
    }
    catch (err) {
        process.stdout.write(`${JSON.stringify({
            status: 'error',
            findings: [],
            elapsed_ms: 0,
            error: safeErrorMessage(err),
        })}\n`);
        process.stderr.write(`check-readiness failed: ${safeErrorMessage(err)}\n`);
        process.exit(1);
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-readiness.js') {
    main();
}
