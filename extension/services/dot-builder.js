// DOT pipeline codegen builder — no process.exit() (eslint-plugin-pickle rule)
import { BuildError } from '../types/index.js';
import { isRecord } from '../lib/is-record.js';
export { BuildError } from '../types/index.js';
import { DEFAULT_FIX_BACKEND_PROMPT, DEFAULT_FIX_FRONTEND_PROMPT, DEFAULT_REVIEW_BE_PROMPT, DEFAULT_REVIEW_FE_PROMPT, DEFAULT_REVIEW_INT_PROMPT, DEFAULT_ADVERSARY_PROMPT, DEFAULT_BUILD_API_CMD, DEFAULT_TESTS_API_CMD, DEFAULT_BUILD_UI_CMD, DEFAULT_LINT_CMD, DEFAULT_FP_VERIFY_CMD, DEFAULT_REPRO_VERIFY_CMD, DEFAULT_FIX_BACKEND_MODEL, DEFAULT_FIX_FRONTEND_MODEL, DEFAULT_REVIEW_BE_MODEL, DEFAULT_REVIEW_FE_MODEL, DEFAULT_REVIEW_INT_MODEL, DEFAULT_ADVERSARY_MODEL, DEFAULT_FIX_BACKEND_HARNESS, DEFAULT_FIX_FRONTEND_HARNESS, DEFAULT_ADVERSARY_SEALED_FROM_SOURCE, DEFAULT_CONVERGENCE_EPSILON, DEFAULT_MAX_ITERATIONS, DEFAULT_CONVERGE_MAX_VISITS, DEFAULT_CONVERGE_TIMEOUT, DEFAULT_FIX_TIMEOUT, DEFAULT_MECHANICAL_BUILD_TIMEOUT, DEFAULT_MECHANICAL_TESTS_TIMEOUT, DEFAULT_REVIEW_TIMEOUT, DEFAULT_GOAL_GATE_TIMEOUT, DEFAULT_COMMIT_PUSH_TIMEOUT, DEFAULT_BODY_MAX_VISITS, DEFAULT_GOAL_GATE_MAX_VISITS, DEFAULT_MECHANICAL_MAX_VISITS, } from './convergence-defaults.js';
// ---------------------------------------------------------------------------
// BUILD_ERROR_CODES — runtime constant, mirrors BuildErrorCode union
// ---------------------------------------------------------------------------
export const BUILD_ERROR_CODES = [
    'EMPTY_SLUG', 'EMPTY_GOAL', 'DUPLICATE_PHASE', 'INVALID_RATCHET',
    'NON_NUMERIC_TARGET', 'ALREADY_BUILT', 'INVALID_STRUCTURE', 'START_HAS_INCOMING',
    'UNREACHABLE_NODE', 'DIAMOND_MISSING_EDGES', 'GOAL_GATE_NO_MAX_VISITS',
    'MISSING_AC_MAPPING', 'MISSING_TIMEOUT', 'PROMPT_PATH_MISMATCH',
    'REVIEW_MISSING_READONLY', 'COMPONENT_NO_MERGE', 'FAN_OUT_SCOPE_LEAK',
    'WORKSPACE_NO_HTTPS', 'WORKSPACE_NO_PUSH', 'PLAN_MODE_DEADLOCK',
    'MISSING_ALLOWED_PATHS', 'INVALID_SPEC', 'INVALID_TIMEOUT', 'INVALID_ALLOWED_PATHS',
    'DUPLICATE_MODEL', 'INVALID_CONVERGENCE_SPEC',
];
// Alias for JS consumers
export const BuildErrorCode = BUILD_ERROR_CODES;
// ---------------------------------------------------------------------------
// Tier 2 auto-keys — distributed across verify_typecheck/verify_lint/verify_tests
// ---------------------------------------------------------------------------
const TIER_2_AUTO_KEYS = {
    cli_contract: 'true',
    determinism: 'true',
    lint_clean: 'true',
    tests_pass: 'true',
    types_compile: 'true',
    validation_rules: 'true',
};
const DEFAULT_ESCALATE_ON = 'package.json,*.lock,*.config.*';
// ---------------------------------------------------------------------------
// Test-dir heuristic: src/X/** → also tests/X/** and __tests__/X/**
// ---------------------------------------------------------------------------
function expandWithTestDirs(paths) {
    const result = [...paths];
    for (const p of paths) {
        const m = p.match(/^src\/(.+)/);
        if (m) {
            const suffix = m[1];
            const testPath = `tests/${suffix}`;
            const dunderPath = `__tests__/${suffix}`;
            if (!result.includes(testPath))
                result.push(testPath);
            if (!result.includes(dunderPath))
                result.push(dunderPath);
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkDiag(rule, severity, message, nodeId) {
    const d = { rule, severity, message };
    if (nodeId !== undefined)
        d.nodeId = nodeId;
    return d;
}
function firstDefined(...values) {
    return values.find(v => v !== undefined);
}
function addModelIfDefined(modelMap, selector, model) {
    if (model)
        modelMap.set(selector, model);
}
function convergenceStylesheetModels(config) {
    const modelMap = new Map();
    if (!config)
        return modelMap;
    const sc = config;
    if (!sc.overrides || sc.overrides.length === 0)
        return modelMap;
    const convergenceClasses = ['.impl', '.honest_review', '.adversary'];
    for (const o of sc.overrides) {
        if (convergenceClasses.includes(o.selector)) {
            modelMap.set(o.selector, o.model);
        }
    }
    return modelMap;
}
function duplicateModelDiagnostic(modelMap) {
    const seen = new Map();
    for (const [selector, model] of modelMap) {
        const prior = seen.get(model);
        if (prior) {
            return [mkDiag('DUPLICATE_MODEL', 'error', `model diversity violation: selectors "${prior}" and "${selector}" both use model "${model}"`)];
        }
        seen.set(model, selector);
    }
    return [];
}
function pass() { return { valid: true, diagnostics: [] }; }
function fail(diagnostics) { return { valid: false, diagnostics }; }
/** Format a requirements array as '1. X, 2. Y, 3. Z'. */
function formatRequirementsList(reqs) {
    return reqs.map((r, i) => `${i + 1}. ${r}`).join(', ');
}
/** Compute max_visits for a test diamond from expected test count. */
function computeMaxVisits(count) {
    return Math.max(3, Math.ceil(count / 3));
}
const UI_REQUIREMENTS = {
    crud: ['pagination', 'edit form', 'delete action', 'empty state'],
    dashboard: ['data loading', 'refresh', 'error state', 'responsive layout'],
    form: ['field validation', 'error display', 'submit handling', 'success feedback'],
    wizard: ['step navigation', 'step validation', 'progress indicator', 'completion state'],
};
/** Serialize a Record<string, string> as sorted K=V comma-separated pairs. */
function serializeKV(record) {
    return Object.entries(record)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
}
/** Escape a string for use inside DOT double-quoted attribute values. */
function escapeAttr(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}
/** Format a key-value map into DOT attribute syntax: key="val", key2="val2" */
function fmtAttrs(map) {
    return Object.keys(map)
        .sort()
        .map(k => `${k}="${escapeAttr(map[k])}"`)
        .join(', ');
}
/** DOT reserved words that cannot be used as bare node identifiers. */
const DOT_RESERVED = new Set([
    'graph', 'digraph', 'subgraph', 'edge', 'node', 'strict',
]);
/** Sanitize a phase name into a valid DOT node identifier. */
function sanitizeId(name) {
    let id = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (/^\d/.test(id))
        id = '_' + id;
    // Prevent collision with DOT reserved words
    if (DOT_RESERVED.has(id))
        id = `phase_${id}`;
    return id;
}
function isCommitPushPhaseId(id) {
    return id === 'commit_and_push' || (id.includes('commit') && id.includes('push'));
}
// ---------------------------------------------------------------------------
// Structural validation helpers
// ---------------------------------------------------------------------------
const RESERVED_IDS = new Set([
    'start', 'exit', 'setup_deps', 'capture_baseline',
    // Endgame structural nodes
    'verify_typecheck', 'verify_lint', 'verify_tests',
    'audit', 'regression_check', 'quality_review',
    'fix_types', 'fix_lint', 'fix_tests', 'fix_quality', 'fix_all', 'fix_review',
    // Iterate convergence nodes
    'converge', 'iter_impl', 'iter_review_be', 'iter_review_fe', 'iter_review_int', 'iter_adversary',
]);
/** Extract path-like tokens (containing '/') from a prompt string. */
function extractPromptPaths(prompt) {
    return (prompt.match(/\b[\w.-]+(?:\/[\w.-]+)+/g) ?? []);
}
// ---------------------------------------------------------------------------
// Pre-flight spec validation — runs before emission; throws on first error
// ---------------------------------------------------------------------------
function preflightReservedIds(phases) {
    const diags = [];
    for (const phase of phases) {
        const id = sanitizeId(phase.name);
        if (RESERVED_IDS.has(id)) {
            diags.push(mkDiag('INVALID_STRUCTURE', 'error', `phase "${phase.name}" sanitizes to reserved node id "${id}"`, id));
        }
    }
    return diags;
}
function preflightDanglingDeps(phases) {
    const knownIds = new Set([
        ...phases.map(p => sanitizeId(p.name)),
        ...phases.map(p => p.name),
    ]);
    const diags = [];
    for (const phase of phases) {
        if (!phase.dependsOn || phase.dependsOn.length === 0)
            continue;
        for (const dep of phase.dependsOn) {
            if (!knownIds.has(dep) && !knownIds.has(sanitizeId(dep))) {
                diags.push(mkDiag('UNREACHABLE_NODE', 'error', `phase "${phase.name}" depends on "${dep}" which does not exist`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightTimeoutFormat(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.timeout)
            continue;
        const match = /^(\d+)([mhd])$/.exec(phase.timeout);
        if (!match) {
            diags.push(mkDiag('INVALID_TIMEOUT', 'error', `phase "${phase.name}" timeout "${phase.timeout}" must match <number><m|h|d> (e.g. "30m")`, sanitizeId(phase.name)));
        }
        else if (parseInt(match[1], 10) === 0) {
            diags.push(mkDiag('INVALID_TIMEOUT', 'error', `phase "${phase.name}" timeout "${phase.timeout}" must be > 0`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightAllowedPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.allowedPaths)
            continue;
        for (const ap of phase.allowedPaths) {
            if (ap.startsWith('/') || ap.startsWith('..')) {
                diags.push(mkDiag('INVALID_ALLOWED_PATHS', 'error', `phase "${phase.name}" allowedPaths contains "${ap}" — must be relative, no absolute or traversal paths`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightStartIncoming(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.retryTarget === 'start') {
            diags.push(mkDiag('START_HAS_INCOMING', 'error', `phase "${phase.name}" retryTarget "start" would create an incoming edge to the start node`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightGoalGateEdges(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.goalGate && !phase.specFirst && !phase.retryTarget) {
            // Auto-correct: default retryTarget to fix_<phaseName>
            const defaultTarget = `fix_${sanitizeId(phase.name)}`;
            phase.retryTarget = defaultTarget;
            diags.push(mkDiag('DIAMOND_MISSING_EDGES', 'warning', `goalGate phase "${phase.name}" missing retryTarget — defaulted to "${defaultTarget}"`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightFanOutScope(phases) {
    const independent = phases.filter(p => !p.dependsOn || p.dependsOn.length === 0);
    if (independent.length < 2)
        return [];
    const indIds = new Set(independent.map(p => sanitizeId(p.name)));
    const diags = [];
    for (const phase of independent) {
        if (!phase.retryTarget)
            continue;
        const thisId = sanitizeId(phase.name);
        for (const otherId of indIds) {
            if (otherId !== thisId && phase.retryTarget.includes(otherId)) {
                diags.push(mkDiag('FAN_OUT_SCOPE_LEAK', 'error', `phase "${phase.name}" retryTarget "${phase.retryTarget}" escapes fan-out scope into branch "${otherId}"`, thisId));
                break;
            }
        }
    }
    return diags;
}
function preflightWorkspaceHttps(workspace, workspaceOpts) {
    if (workspace !== 'isolated')
        return [];
    if (!workspaceOpts?.repoUrl)
        return [];
    const repoUrl = workspaceOpts.repoUrl;
    if (!repoUrl.startsWith('https://')) {
        // Auto-correct: convert git@host:org/repo.git → https://host/org/repo.git
        const sshMatch = repoUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
        if (sshMatch) {
            const converted = `https://${sshMatch[1]}/${sshMatch[2]}.git`;
            workspaceOpts.repoUrl = converted;
            return [mkDiag('WORKSPACE_NO_HTTPS', 'warning', `workspace="isolated" requires HTTPS repo_url — auto-converted "${repoUrl}" → "${converted}"`)];
        }
        return [mkDiag('WORKSPACE_NO_HTTPS', 'error', `workspace="isolated" requires HTTPS repo_url; got: "${repoUrl}" (unable to auto-convert)`)];
    }
    return [];
}
function preflightPlanDeadlock(phases) {
    return phases
        .filter(p => p.specFirst && p.goalGate)
        .map(p => mkDiag('PLAN_MODE_DEADLOCK', 'error', `phase "${p.name}" combines specFirst+goalGate, producing plan-mode deadlock in headless pipeline`, sanitizeId(p.name)));
}
function preflightWorkspacePush(workspace, phases) {
    if (workspace !== 'isolated')
        return [];
    const hasCommitPush = phases.some(p => {
        const id = sanitizeId(p.name);
        return id === 'commit_and_push' || (id.includes('commit') && id.includes('push'));
    });
    if (!hasCommitPush) {
        // Downgrade to warning — _emitDot will auto-inject commit_and_push tool node
        return [mkDiag('WORKSPACE_NO_PUSH', 'warning', 'workspace="isolated" missing commit_and_push — will auto-inject push node after quality_review')];
    }
    return [];
}
function preflightPromptPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.allowedPaths || phase.allowedPaths.length === 0)
            continue;
        for (const p of extractPromptPaths(phase.prompt)) {
            const covered = phase.allowedPaths.some(ap => p.startsWith(ap) || ap.startsWith(p + '/'));
            if (!covered) {
                diags.push(mkDiag('PROMPT_PATH_MISMATCH', 'error', `phase "${phase.name}" prompt references path "${p}" outside allowedPaths`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightAutoMapAC(phases, acceptanceCriteria) {
    const acKeys = Object.keys(acceptanceCriteria);
    if (acKeys.length === 0)
        return [];
    const tier2 = new Set(Object.keys(TIER_2_AUTO_KEYS));
    const customKeys = acKeys.filter(k => !tier2.has(k));
    if (customKeys.length === 0)
        return [];
    // Collect already-mapped keys
    const alreadyMapped = new Set();
    for (const p of phases) {
        if (p.contextOnSuccess) {
            for (const k of Object.keys(p.contextOnSuccess))
                alreadyMapped.add(k);
        }
    }
    const unmapped = customKeys.filter(k => !alreadyMapped.has(k));
    if (unmapped.length === 0)
        return [];
    const implPhases = phases.filter(p => !p.securityScan && !p.docOnly);
    // Single-phase shortcut: all unmapped custom keys → the only phase
    if (implPhases.length === 1) {
        const phase = implPhases[0];
        if (!phase.contextOnSuccess)
            phase.contextOnSuccess = {};
        for (const k of unmapped) {
            phase.contextOnSuccess[k] = String(acceptanceCriteria[k] ?? 'true');
        }
        return [mkDiag('MISSING_AC_MAPPING', 'info', `single-phase pipeline — auto-mapped ${unmapped.length} AC key(s) to phase "${phase.name}": ${unmapped.join(', ')}`)];
    }
    // Multi-phase: try prefix/substring match
    const diags = [];
    for (const k of unmapped) {
        const match = implPhases.find(p => {
            const id = sanitizeId(p.name);
            return k.includes(id) || id.includes(k.replace(/_/g, ''));
        });
        if (match) {
            if (!match.contextOnSuccess)
                match.contextOnSuccess = {};
            match.contextOnSuccess[k] = String(acceptanceCriteria[k] ?? 'true');
            diags.push(mkDiag('MISSING_AC_MAPPING', 'info', `auto-mapped AC key "${k}" to phase "${match.name}" (name match)`));
        }
        // If no match, let grRule6 handle it with better fix hints
    }
    return diags;
}
function preflightMissingAllowedPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.securityScan || phase.docOnly)
            continue;
        if (!phase.allowedPaths || phase.allowedPaths.length === 0) {
            // Auto-correct: default to src/**/tests/** and warn
            phase.allowedPaths = ['src/**', 'tests/**'];
            diags.push(mkDiag('MISSING_ALLOWED_PATHS', 'warning', `phase "${phase.name}" missing allowedPaths — defaulted to ["src/**", "tests/**"]`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function buildPhaseDependencyGraph(phases) {
    const adj = new Map();
    const ids = new Set();
    for (const p of phases) {
        const id = sanitizeId(p.name);
        ids.add(id);
        adj.set(id, []);
    }
    for (const p of phases) {
        const id = sanitizeId(p.name);
        if (!p.dependsOn)
            continue;
        for (const dep of p.dependsOn) {
            const depId = ids.has(dep) ? dep : sanitizeId(dep);
            if (ids.has(depId))
                adj.get(depId).push(id);
        }
    }
    return { adj, ids };
}
function buildInDegreeMap(ids, adj) {
    const inDeg = new Map();
    for (const id of ids)
        inDeg.set(id, 0);
    for (const [, targets] of adj) {
        for (const t of targets)
            inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
    return inDeg;
}
function countTopologicalVisits(ids, adj, inDeg) {
    const queue = [...ids].filter(id => inDeg.get(id) === 0);
    let visited = 0;
    while (queue.length > 0) {
        const node = queue.shift();
        visited++;
        for (const next of (adj.get(node) ?? [])) {
            const d = inDeg.get(next) - 1;
            inDeg.set(next, d);
            if (d === 0)
                queue.push(next);
        }
    }
    return visited;
}
function preflightCircularDeps(phases) {
    const { adj, ids } = buildPhaseDependencyGraph(phases);
    const inDeg = buildInDegreeMap(ids, adj);
    const visited = countTopologicalVisits(ids, adj, inDeg);
    if (visited < ids.size) {
        const cycle = [...ids].filter(id => (inDeg.get(id) ?? 0) > 0);
        return [mkDiag('INVALID_STRUCTURE', 'error', `circular dependency detected among phases: ${cycle.join(', ')}`)];
    }
    return [];
}
// ---------------------------------------------------------------------------
// 15 structural validation rules — run sequentially on the complete graph.
// ---------------------------------------------------------------------------
function grRule1(nodeMap) {
    const diamonds = [...nodeMap.entries()].filter(([, a]) => a['shape'] === 'Mdiamond');
    const squares = [...nodeMap.entries()].filter(([, a]) => a['shape'] === 'Msquare');
    const diags = [];
    if (diamonds.length !== 1) {
        diags.push(mkDiag('INVALID_STRUCTURE', 'error', `graph must have exactly 1 Mdiamond (start) node; found ${diamonds.length}`));
    }
    if (squares.length !== 1) {
        diags.push(mkDiag('INVALID_STRUCTURE', 'error', `graph must have exactly 1 Msquare (exit) node; found ${squares.length}`));
    }
    return diags;
}
function grRule2(nodeMap, edgeList) {
    const startEntry = [...nodeMap.entries()].find(([, a]) => a['shape'] === 'Mdiamond');
    if (!startEntry)
        return [];
    const startId = startEntry[0];
    const incoming = edgeList.filter(e => e.to === startId);
    if (incoming.length > 0) {
        return [mkDiag('START_HAS_INCOMING', 'error', `start node "${startId}" has ${incoming.length} incoming edge(s); must have 0`, startId)];
    }
    return [];
}
function grRule3(nodeMap, edgeList, standaloneNodeIds) {
    const startEntry = [...nodeMap.entries()].find(([, a]) => a['shape'] === 'Mdiamond');
    if (!startEntry)
        return [];
    const startId = startEntry[0];
    const adj = new Map();
    for (const id of nodeMap.keys())
        adj.set(id, []);
    for (const e of edgeList) {
        const neighbors = adj.get(e.from);
        if (neighbors)
            neighbors.push(e.to);
    }
    const visited = new Set();
    const queue = [startId];
    while (queue.length > 0) {
        const node = queue.shift();
        if (visited.has(node))
            continue;
        visited.add(node);
        for (const next of (adj.get(node) ?? []))
            queue.push(next);
    }
    return [...nodeMap.keys()]
        .filter(id => !visited.has(id) && !standaloneNodeIds.has(id))
        .map(id => mkDiag('UNREACHABLE_NODE', 'error', `node "${id}" is not reachable from the start node`, id));
}
function grRule4(nodeMap, edgeList) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['shape'] !== 'diamond')
            continue;
        const outCount = edgeList.filter(e => e.from === id).length;
        if (outCount < 2) {
            diags.push(mkDiag('DIAMOND_MISSING_EDGES', 'error', `diamond node "${id}" has ${outCount} outgoing edge(s); must have ≥2`, id));
        }
    }
    return diags;
}
function grRule5(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['retry_target'] && !attrs['max_visits']) {
            diags.push(mkDiag('GOAL_GATE_NO_MAX_VISITS', 'error', `node "${id}" has retry_target but no max_visits — unbounded retry loop`, id));
        }
    }
    return diags;
}
function grRule6(nodeMap, acceptanceCriteria) {
    const acKeys = Object.keys(acceptanceCriteria);
    if (acKeys.length === 0)
        return [];
    const mapped = new Set();
    for (const attrs of nodeMap.values()) {
        if (attrs['context_on_success']) {
            for (const pair of attrs['context_on_success'].split(',')) {
                mapped.add(pair.split('=')[0].trim());
            }
        }
    }
    const unmapped = acKeys.filter(k => !mapped.has(k));
    if (unmapped.length === 0)
        return [];
    // Collect conformance node IDs for fix hints
    const conformanceNodes = [...nodeMap.entries()]
        .filter(([id]) => id.startsWith('conformance_'))
        .map(([id]) => id.replace('conformance_', ''));
    return unmapped.map(k => {
        // Suggest a phase by prefix/substring match
        const match = conformanceNodes.find(phaseName => k.includes(phaseName) || phaseName.includes(k.replace(/_/g, '')));
        const fix = match
            ? `Add contextOnSuccess: { "${k}": "true" } to phase "${match}"`
            : conformanceNodes.length === 1
                ? `Add contextOnSuccess: { "${k}": "true" } to phase "${conformanceNodes[0]}" (only phase)`
                : `Add contextOnSuccess: { "${k}": "true" } to the phase that verifies this criterion. Phases: ${conformanceNodes.join(', ')}`;
        const d = mkDiag('MISSING_AC_MAPPING', 'error', `acceptanceCriteria key "${k}" has no node with context_on_success mapping it`);
        d.fix = fix;
        return d;
    });
}
function grRule7(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] === 'codergen' && !attrs['timeout']) {
            diags.push(mkDiag('MISSING_TIMEOUT', 'error', `codergen node "${id}" is missing a timeout attribute`, id));
        }
    }
    return diags;
}
function grRule8(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const label = attrs['label'];
        const apStr = attrs['allowed_paths'];
        if (!label || !apStr)
            continue;
        const allowedPaths = apStr.split(',').filter(Boolean);
        if (allowedPaths.length === 0)
            continue;
        for (const p of extractPromptPaths(label)) {
            const covered = allowedPaths.some(ap => p.startsWith(ap) || ap.startsWith(p + '/'));
            if (!covered) {
                diags.push(mkDiag('PROMPT_PATH_MISMATCH', 'error', `node "${id}" label references path "${p}" outside allowed_paths`, id));
                break;
            }
        }
    }
    return diags;
}
function grRule9(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] !== 'review')
            continue;
        if (attrs['read_only'] !== 'true' || !attrs['label']?.includes('STATUS')) {
            diags.push(mkDiag('REVIEW_MISSING_READONLY', 'error', `review node "${id}" must have read_only=true and STATUS in label`, id));
        }
    }
    return diags;
}
function grRule10(nodeMap, _edgeList) {
    const hasComponent = [...nodeMap.values()].some(a => a['shape'] === 'component');
    if (!hasComponent)
        return [];
    const hasTripleOctagon = [...nodeMap.values()].some(a => a['shape'] === 'tripleoctagon');
    if (!hasTripleOctagon) {
        return [mkDiag('COMPONENT_NO_MERGE', 'warning', 'component nodes present but no tripleoctagon merge node found — builder will auto-emit one (Pattern 4)')];
    }
    return [];
}
function grRule11(nodeMap) {
    const componentIds = new Set([...nodeMap.entries()]
        .filter(([, a]) => a['shape'] === 'component')
        .map(([id]) => id));
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const retryTarget = attrs['retry_target'];
        if (!retryTarget || !componentIds.has(id))
            continue;
        const otherBranches = [...componentIds].filter(cid => cid !== id && !cid.includes('merge') && !cid.includes('split'));
        for (const otherId of otherBranches) {
            if (retryTarget.includes(otherId)) {
                diags.push(mkDiag('FAN_OUT_SCOPE_LEAK', 'error', `node "${id}" retry_target "${retryTarget}" escapes fan-out scope into branch "${otherId}"`, id));
                break;
            }
        }
    }
    return diags;
}
function grRule12(nodeMap, graphAttrs) {
    if (graphAttrs['workspace'] !== 'isolated')
        return [];
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const repoUrl = attrs['repo_url'];
        if (repoUrl && !repoUrl.startsWith('https://')) {
            diags.push(mkDiag('WORKSPACE_NO_HTTPS', 'error', `node "${id}" workspace=isolated requires HTTPS repo_url; got "${repoUrl}"`, id));
        }
    }
    return diags;
}
function grRule13(nodeMap, graphAttrs) {
    if (graphAttrs['workspace'] !== 'isolated')
        return [];
    const hasCommitPush = [...nodeMap.keys()].some(id => id === 'commit_and_push' || (id.includes('commit') && id.includes('push')));
    if (!hasCommitPush) {
        // Should not fire — preflight auto-injects commit_and_push. Warn as safety net.
        return [mkDiag('WORKSPACE_NO_PUSH', 'warning', 'workspace=isolated but no commit_and_push node found after auto-injection — check pipeline structure')];
    }
    return [];
}
function grRule14(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['permission_mode'] === 'plan') {
            diags.push(mkDiag('PLAN_MODE_DEADLOCK', 'error', `node "${id}" uses permission_mode=plan — deadlock in headless pipeline`, id));
        }
    }
    return diags;
}
function grRule15(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] === 'codergen') {
            const ap = attrs['allowed_paths'];
            if (!ap || ap.trim() === '') {
                diags.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', `codergen node "${id}" requires non-empty allowed_paths`, id));
            }
        }
    }
    return diags;
}
function grRule16(nodeMap, acceptanceCriteria) {
    const acKeys = new Set(Object.keys(acceptanceCriteria));
    const tier2Keys = new Set(Object.keys(TIER_2_AUTO_KEYS));
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (!attrs['context_on_success'])
            continue;
        for (const pair of attrs['context_on_success'].split(',')) {
            const key = pair.split('=')[0].trim();
            if (!acKeys.has(key) && !tier2Keys.has(key)) {
                diags.push(mkDiag('ORPHANED_CONTEXT_KEY', 'warning', `node "${id}" context_on_success key "${key}" is not in acceptanceCriteria`, id));
            }
        }
    }
    return diags;
}
// ---------------------------------------------------------------------------
// Runtime validator namespace objects
// ---------------------------------------------------------------------------
function validateDiagnosticEdge(edge) {
    if (edge === undefined)
        return;
    if (!Array.isArray(edge) || edge.length !== 2 || typeof edge[0] !== 'string' || typeof edge[1] !== 'string') {
        throw new Error('Diagnostic edge must be a tuple of exactly two strings');
    }
}
export const DiagnosticNs = {
    create(data) {
        if (!isRecord(data))
            throw new Error('Diagnostic.create requires an object');
        const { rule, severity, message, nodeId, edge, fix } = data;
        if (typeof rule !== 'string' || !rule)
            throw new Error('Diagnostic requires a non-empty rule');
        if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
            throw new Error(`Diagnostic severity must be error, warning, or info; got: ${String(severity)}`);
        }
        if (typeof message !== 'string')
            throw new Error('Diagnostic requires a message string');
        validateDiagnosticEdge(edge);
        const result = { rule, severity, message };
        if (typeof nodeId === 'string')
            result.nodeId = nodeId;
        if (Array.isArray(edge) && edge.length === 2)
            result.edge = edge;
        if (typeof fix === 'string')
            result.fix = fix;
        return result;
    },
};
// Alias: compiled JS exports as both `Diagnostic` and `DiagnosticNs`
export { DiagnosticNs as Diagnostic };
export const ValidationResultNs = {
    validate(vr) {
        if (!isRecord(vr))
            return fail([mkDiag('INVALID_SPEC', 'error', 'ValidationResult must be an object')]);
        const diagnostics = [];
        if (typeof vr['valid'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'valid must be a boolean'));
        }
        if (!Array.isArray(vr['diagnostics'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'diagnostics must be an array'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { ValidationResultNs as ValidationResult };
const VALID_SPEC_DRIVEN = [
    'NONE', 'conformance', 'BDD + conformance',
    'spec_file + conformance', 'spec_file + BDD + conformance',
];
export const DefenseMatrixNs = {
    validate(dm) {
        if (!isRecord(dm))
            return fail([mkDiag('INVALID_SPEC', 'error', 'DefenseMatrix must be an object')]);
        const diagnostics = [];
        if (typeof dm['competitive'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'competitive must be a boolean'));
        }
        if (typeof dm['adversarial'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'adversarial must be a boolean'));
        }
        if (!Array.isArray(dm['guardrails']) || !dm['guardrails'].every((g) => typeof g === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'guardrails must be a string array'));
        }
        if (!Array.isArray(dm['permissions']) || !dm['permissions'].every((p) => typeof p === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'permissions must be a string array'));
        }
        if (!VALID_SPEC_DRIVEN.includes(dm['specDriven'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', `specDriven must be one of: ${VALID_SPEC_DRIVEN.join(', ')}`));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { DefenseMatrixNs as DefenseMatrix };
export const BuildResultNs = {
    validate(result) {
        if (!isRecord(result))
            return fail([mkDiag('INVALID_SPEC', 'error', 'BuildResult must be an object')]);
        const diagnostics = [];
        if (typeof result['dot'] !== 'string' || !result['dot']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'dot must be a non-empty string'));
        }
        if (typeof result['slug'] !== 'string') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'slug must be a string'));
        }
        if (!Array.isArray(result['patternsApplied']) || !result['patternsApplied'].every((p) => typeof p === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'patternsApplied must be a string array'));
        }
        if (!Array.isArray(result['diagnostics'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'diagnostics must be an array'));
        }
        if (!result['defenseMatrix'] || typeof result['defenseMatrix'] !== 'object' || Array.isArray(result['defenseMatrix'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'defenseMatrix must be an object'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
// Alias for CLI test compatibility
export { BuildResultNs as BuildResult };
export const MicroverseOptsNs = {
    validate(opts) {
        if (!isRecord(opts))
            return fail([mkDiag('INVALID_SPEC', 'error', 'MicroverseOpts must be an object')]);
        const diagnostics = [];
        if (typeof opts['prompt'] !== 'string' || !opts['prompt']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'prompt is required'));
        }
        if (typeof opts['measureCommand'] !== 'string' || !opts['measureCommand']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'measureCommand is required'));
        }
        if (typeof opts['target'] !== 'number') {
            diagnostics.push(mkDiag('NON_NUMERIC_TARGET', 'error', 'target must be a number'));
        }
        if (opts['direction'] !== 'reduce' && opts['direction'] !== 'improve') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'direction must be "reduce" or "improve"'));
        }
        if (!Array.isArray(opts['allowedPaths'])) {
            diagnostics.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', 'allowedPaths is required'));
        }
        if (opts['maxVisits'] !== undefined) {
            const mv = opts['maxVisits'];
            if (typeof mv !== 'number' || !Number.isInteger(mv) || mv < 1) {
                diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'maxVisits must be a positive integer >= 1'));
            }
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { MicroverseOptsNs as MicroverseOpts };
export const WorkspaceOptsNs = {
    validate(opts) {
        if (!isRecord(opts))
            return fail([mkDiag('INVALID_SPEC', 'error', 'WorkspaceOpts must be an object')]);
        const diagnostics = [];
        const cleanup = opts['cleanup'];
        if (cleanup !== undefined && cleanup !== 'delete' && cleanup !== 'preserve') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'cleanup must be "delete" or "preserve"'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { WorkspaceOptsNs as WorkspaceOpts };
export const StylesheetConfigNs = {
    validate(config) {
        if (!isRecord(config))
            return fail([mkDiag('INVALID_SPEC', 'error', 'StylesheetConfig must be an object')]);
        const diagnostics = [];
        if (typeof config['defaultModel'] !== 'string' || !config['defaultModel']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'defaultModel is required'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { StylesheetConfigNs as StylesheetConfig };
export const PhaseSpecNs = {
    validate(phase) {
        if (!isRecord(phase))
            return fail([mkDiag('INVALID_SPEC', 'error', 'PhaseSpec must be an object')]);
        const diagnostics = [];
        if (typeof phase['name'] !== 'string' || !phase['name']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'name is required'));
        }
        if (typeof phase['prompt'] !== 'string' || !phase['prompt']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'prompt is required'));
        }
        // allowedPaths validated by preflight (auto-corrected if missing)
        if (phase['allowedPaths'] !== undefined && !Array.isArray(phase['allowedPaths'])) {
            diagnostics.push(mkDiag('INVALID_ALLOWED_PATHS', 'error', 'allowedPaths must be an array when provided'));
        }
        if (phase['dependsOn'] !== undefined) {
            if (!Array.isArray(phase['dependsOn']) || !phase['dependsOn'].every((d) => typeof d === 'string')) {
                diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'dependsOn must be an array of strings'));
            }
        }
        const valid = diagnostics.length === 0;
        const result = { valid, diagnostics };
        if (phase['docOnly'] === true)
            result.docOnly = true;
        return result;
    },
};
export { PhaseSpecNs as PhaseSpec };
export const BuilderSpecNs = {
    validate(spec) {
        if (!isRecord(spec)) {
            return fail([
                mkDiag('EMPTY_SLUG', 'error', 'slug is required'),
                mkDiag('EMPTY_GOAL', 'error', 'goal is required'),
                mkDiag('INVALID_SPEC', 'error', 'phases is required'),
            ]);
        }
        const diagnostics = [];
        if (typeof spec['slug'] !== 'string') {
            diagnostics.push(mkDiag('EMPTY_SLUG', 'error', 'slug is required'));
        }
        else if (!spec['slug'].trim()) {
            diagnostics.push(mkDiag('EMPTY_SLUG', 'error', 'slug cannot be empty'));
        }
        if (typeof spec['goal'] !== 'string') {
            diagnostics.push(mkDiag('EMPTY_GOAL', 'error', 'goal is required'));
        }
        else if (!spec['goal'].trim()) {
            diagnostics.push(mkDiag('EMPTY_GOAL', 'error', 'goal cannot be empty'));
        }
        if (!Array.isArray(spec['phases'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'phases is required and must be an array'));
        }
        if (spec['workspace'] !== undefined && spec['workspace'] !== 'isolated') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'workspace must be "isolated" or undefined'));
        }
        if (spec['reviewRatchet'] !== undefined) {
            const rr = spec['reviewRatchet'];
            if (typeof rr !== 'number' || rr < 2) {
                diagnostics.push(mkDiag('INVALID_RATCHET', 'error', 'reviewRatchet must be >= 2'));
            }
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { BuilderSpecNs as BuilderSpec };
export function _parsePhases(raw) {
    if (!Array.isArray(raw)) {
        throw new BuildError('INVALID_SPEC', 'spec.phases must be an array');
    }
    return raw.map((p) => {
        if (!isRecord(p) || typeof p['name'] !== 'string') {
            throw new BuildError('INVALID_SPEC', 'each phase must be an object with a string "name" field');
        }
        return p;
    });
}
function recordOrEmpty(raw) {
    return isRecord(raw) ? raw : {};
}
function copyConvergenceRecord(out, cv, key) {
    if (isRecord(cv[key])) {
        out[key] = cv[key];
    }
}
function copyConvergenceNumber(out, cv, key) {
    if (typeof cv[key] === 'number') {
        out[key] = cv[key];
    }
}
function copyConvergenceString(out, cv, key) {
    if (typeof cv[key] === 'string') {
        out[key] = cv[key];
    }
}
export function _parseConvergenceSpec(raw) {
    if (!isRecord(raw))
        return null;
    const cv = raw;
    const impl = recordOrEmpty(cv['impl']);
    const out = {
        until: cv['until'],
        impl: {
            harness: impl['harness'] || 'claude-code',
            prompt: impl['prompt'] || '',
        },
    };
    ['timeout', 'sealedFromSource'].forEach(key => copyConvergenceString(out, cv, key));
    ['fixBackend', 'fixFrontend', 'mechanicalGates', 'reviewers', 'adversary', 'fpVerify', 'reproVerify']
        .forEach(key => copyConvergenceRecord(out, cv, key));
    ['maxVisits', 'convergenceEpsilon', 'maxIterations'].forEach(key => copyConvergenceNumber(out, cv, key));
    return out;
}
function applySpecConfig(builder, spec) {
    if (spec['workspace'] === 'isolated') {
        builder.workspace(isRecord(spec['workspaceOpts']) ? spec['workspaceOpts'] : undefined);
    }
    if (isRecord(spec['microverse'])) {
        const mv = spec['microverse'];
        if (typeof mv['name'] === 'string' && isRecord(mv['opts']))
            builder.microverse(mv['name'], mv['opts']);
    }
    if (typeof spec['reviewRatchet'] === 'number')
        builder.reviewRatchet(spec['reviewRatchet']);
    if (isRecord(spec['modelStylesheet']))
        builder.modelStylesheet(spec['modelStylesheet']);
    if (isRecord(spec['endgame']))
        builder.endgame(spec['endgame']);
    const convergence = _parseConvergenceSpec(spec['convergence']);
    if (convergence)
        builder.convergence(convergence);
}
export class DotBuilder {
    _slug;
    _goal;
    _phases = [];
    _seenIds = new Set();
    _spec;
    _built = false;
    _nodes = [];
    _edges = [];
    _subgraphBlocks = [];
    _seenEdges = new Set();
    _nodeMap = new Map();
    _edgeList = [];
    _standaloneNodeIds = new Set();
    _emittedDiagnostics = [];
    _applied = new Set();
    _graphAttrs = {};
    _defenseMatrix = {
        competitive: false,
        guardrails: [],
        specDriven: 'NONE',
        permissions: [],
        adversarial: false,
    };
    _independentPhases = [];
    _implPhases = [];
    _hasFanOut = false;
    _hasCompeting = false;
    _hasConvergence = false;
    _unionPaths = '';
    _unionEscalate = '';
    _verifyTypecheckKV = {};
    _verifyLintKV = {};
    _verifyTestsKV = {};
    static fromSpec(raw) {
        if (!isRecord(raw)) {
            throw new BuildError('INVALID_SPEC', 'spec must be a non-null object');
        }
        const spec = raw;
        const phases = _parsePhases(spec['phases']);
        const base = {
            slug: spec['slug'],
            goal: spec['goal'],
            phases: [],
            acceptanceCriteria: (isRecord(spec['acceptanceCriteria']) ? spec['acceptanceCriteria'] : {}),
            workingDir: typeof spec['workingDir'] === 'string' ? spec['workingDir'] : undefined,
            label: typeof spec['label'] === 'string' ? spec['label'] : undefined,
            defaultMaxRetry: typeof spec['defaultMaxRetry'] === 'number' ? spec['defaultMaxRetry'] : undefined,
            specFile: typeof spec['specFile'] === 'string' ? spec['specFile'] : undefined,
        };
        const builder = new DotBuilder(base);
        for (const p of phases)
            builder.phase(p);
        applySpecConfig(builder, spec);
        return builder;
    }
    constructor(spec) {
        if (typeof spec.slug !== 'string' || !spec.slug.trim()) {
            throw new BuildError('EMPTY_SLUG', 'slug cannot be empty');
        }
        if (typeof spec.goal !== 'string' || !spec.goal.trim()) {
            throw new BuildError('EMPTY_GOAL', 'goal cannot be empty');
        }
        if (spec.reviewRatchet !== undefined && spec.reviewRatchet < 2) {
            throw new BuildError('INVALID_RATCHET', 'reviewRatchet must be >= 2');
        }
        this._spec = spec;
        this._slug = spec.slug.trim();
        this._goal = spec.goal.trim();
        for (const p of spec.phases) {
            this.phase(p);
        }
    }
    phase(first, opts) {
        if (this._built) {
            throw new BuildError('ALREADY_BUILT', 'cannot add phases after build() has been called');
        }
        const phaseSpec = typeof first === 'string' ? { name: first, ...opts } : first;
        const id = sanitizeId(phaseSpec.name);
        if (!id) {
            throw new BuildError('EMPTY_SLUG', `phase name "${phaseSpec.name}" sanitizes to empty string — must contain ASCII alphanumeric characters`);
        }
        if (this._seenIds.has(id)) {
            throw new BuildError('DUPLICATE_PHASE', `duplicate phase id after sanitization: "${id}"`);
        }
        this._seenIds.add(id);
        this._phases.push(phaseSpec);
        return this;
    }
    microverse(name, opts) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call microverse() after build()');
        this._spec = { ...this._spec, microverse: { name, opts } };
        return this;
    }
    reviewRatchet(passes) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call reviewRatchet() after build()');
        if (passes < 2)
            throw new BuildError('INVALID_RATCHET', 'reviewRatchet must be >= 2');
        this._spec = { ...this._spec, reviewRatchet: passes };
        return this;
    }
    acceptanceCriteria(criteria) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call acceptanceCriteria() after build()');
        this._spec = { ...this._spec, acceptanceCriteria: criteria };
        return this;
    }
    workspace(opts) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call workspace() after build()');
        this._spec = { ...this._spec, workspace: 'isolated', workspaceOpts: opts };
        return this;
    }
    modelStylesheet(config) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call modelStylesheet() after build()');
        this._spec = { ...this._spec, modelStylesheet: config };
        return this;
    }
    endgame(opts) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call endgame() after build()');
        this._spec = { ...this._spec, endgame: opts };
        return this;
    }
    convergence(spec) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot modify after build()');
        this._spec = { ...this._spec, convergence: { ...spec } };
        return this;
    }
    /**
     * Single source of truth for merging user-supplied acceptanceCriteria with
     * the convergence-mode built-ins (`fp_pass`, `repro_pass`). Built-ins win
     * on collision. Returns the plain user criteria when convergence is off.
     */
    _mergedAcceptanceCriteria() {
        const ac = this._spec.acceptanceCriteria ?? {};
        return this._spec.convergence
            ? { ...ac, fp_pass: 'true', repro_pass: 'true' }
            : { ...ac };
    }
    build() {
        if (this._built) {
            throw new BuildError('ALREADY_BUILT', 'build() has already been called');
        }
        this._built = true;
        const preflightDiags = this._validatePreflightSpecs();
        const preflightError = preflightDiags.find(d => d.severity === 'error');
        if (preflightError) {
            throw new BuildError(preflightError.rule, preflightError.message, preflightDiags);
        }
        const convergenceDiags = this._validateConvergenceSpec();
        const convergenceError = convergenceDiags.find(d => d.severity === 'error');
        if (convergenceError) {
            throw new BuildError(convergenceError.rule, convergenceError.message);
        }
        const { dot, patternsApplied, defenseMatrix } = this._emitDot();
        const preflightNonErrors = preflightDiags.filter(d => d.severity !== 'error');
        const diagnostics = [
            ...preflightNonErrors,
            ...this._runStructuralRules(),
        ];
        const firstError = diagnostics.find(d => d.severity === 'error');
        if (firstError) {
            throw new BuildError(firstError.rule, firstError.message, diagnostics);
        }
        return { dot, slug: this._slug, patternsApplied, defenseMatrix, diagnostics };
    }
    _validatePreflightSpecs() {
        const phases = this._phases;
        return [
            ...preflightReservedIds(phases),
            ...preflightDanglingDeps(phases),
            ...preflightTimeoutFormat(phases),
            ...preflightAllowedPaths(phases),
            ...preflightCircularDeps(phases),
            ...preflightStartIncoming(phases),
            ...preflightGoalGateEdges(phases),
            ...preflightFanOutScope(phases),
            ...preflightWorkspaceHttps(this._spec.workspace, this._spec.workspaceOpts),
            ...preflightWorkspacePush(this._spec.workspace, phases),
            ...preflightPlanDeadlock(phases),
            ...preflightMissingAllowedPaths(phases),
            ...preflightAutoMapAC(phases, this._spec.acceptanceCriteria ?? {}),
            ...preflightPromptPaths(phases), // must run after allowedPaths auto-correction
        ];
    }
    _validateConvergenceSpec() {
        const cv = this._spec.convergence;
        if (!cv)
            return [];
        const validPredicates = ['V_total == 0', 'V_total == 0 && fixed_point', 'V_total == 0 && fixed_point && reproducibility'];
        if (!validPredicates.includes(cv.until)) {
            return [mkDiag('INVALID_CONVERGENCE_SPEC', 'error', `invalid until predicate: "${cv.until}" — must be one of: ${validPredicates.join(', ')}`)];
        }
        return this._validateConvergenceModelDiversity(cv);
    }
    _validateConvergenceModelDiversity(cv) {
        const modelMap = convergenceStylesheetModels(this._spec.modelStylesheet);
        addModelIfDefined(modelMap, '.impl', firstDefined(cv.fixBackend?.model, cv.fixFrontend?.model));
        addModelIfDefined(modelMap, '.honest_review', firstDefined(cv.reviewers?.be?.model, cv.reviewers?.fe?.model, cv.reviewers?.int?.model));
        addModelIfDefined(modelMap, '.adversary', cv.adversary?.model);
        return duplicateModelDiagnostic(modelMap);
    }
    _runStructuralRules() {
        const mergedAc = this._mergedAcceptanceCriteria();
        return [
            ...this._emittedDiagnostics,
            ...grRule1(this._nodeMap),
            ...grRule2(this._nodeMap, this._edgeList),
            ...grRule3(this._nodeMap, this._edgeList, this._standaloneNodeIds),
            ...grRule4(this._nodeMap, this._edgeList),
            ...grRule5(this._nodeMap),
            ...grRule6(this._nodeMap, mergedAc),
            ...grRule7(this._nodeMap),
            ...grRule8(this._nodeMap),
            ...grRule9(this._nodeMap),
            ...grRule10(this._nodeMap, this._edgeList),
            ...grRule11(this._nodeMap),
            ...grRule12(this._nodeMap, this._graphAttrs),
            ...grRule13(this._nodeMap, this._graphAttrs),
            ...grRule14(this._nodeMap),
            ...grRule15(this._nodeMap),
            ...grRule16(this._nodeMap, mergedAc),
        ];
    }
    // ---------------------------------------------------------------------------
    // Pattern emission
    // ---------------------------------------------------------------------------
    _buildStylesheet(config) {
        const sc = config;
        const parts = [];
        const universalProps = [];
        if (sc.defaultModel)
            universalProps.push(`llm_model: ${sc.defaultModel};`);
        const effort = sc.defaultEffort ?? sc.reasoningEffort;
        if (effort)
            universalProps.push(`reasoning_effort: ${effort};`);
        if (universalProps.length > 0)
            parts.push(`.default { ${universalProps.join(' ')} }`);
        if (sc.overrides && sc.overrides.length > 0) {
            for (const ov of sc.overrides) {
                const sel = ov.selector === '*' ? '.default' : ov.selector.startsWith('.') ? ov.selector : `.${ov.selector}`;
                const props = [`llm_model: ${ov.model};`];
                if (ov.effort)
                    props.push(`reasoning_effort: ${ov.effort};`);
                parts.push(`${sel} { ${props.join(' ')} }`);
            }
        }
        else {
            if (sc.criticalModel)
                parts.push(`.critical { llm_model: ${sc.criticalModel}; }`);
            if (sc.reviewModel)
                parts.push(`.review { llm_model: ${sc.reviewModel}; }`);
        }
        return parts.join(' ');
    }
    _resetEmitState() {
        this._nodes = [];
        this._edges = [];
        this._subgraphBlocks = [];
        this._seenEdges = new Set();
        this._nodeMap = new Map();
        this._edgeList = [];
        this._standaloneNodeIds = new Set();
        this._emittedDiagnostics = [];
        this._applied = new Set();
        this._graphAttrs = {};
        this._defenseMatrix = {
            competitive: false,
            guardrails: [],
            specDriven: 'NONE',
            permissions: [],
            adversarial: false,
        };
        this._independentPhases = [];
        this._implPhases = [];
        this._hasFanOut = false;
        this._hasCompeting = false;
        this._hasConvergence = false;
        this._unionPaths = '';
        this._unionEscalate = '';
        this._verifyTypecheckKV = {};
        this._verifyLintKV = {};
        this._verifyTestsKV = {};
    }
    // eslint-disable-next-line complexity -- HT-1 reviewed: context initialization folds independent schema feature flags.
    _initializeEmitContext() {
        const spec = this._spec;
        const phases = this._phases;
        const hasRedTeam = phases.some(p => p.redTeam);
        const hasBDD = phases.some(p => p.bddScenarios);
        const hasSpecFile = Boolean(spec.specFile);
        const hasSpecFirstAny = phases.some(p => p.specFirst === true || (p.goalGate && p.specFirst !== false));
        this._independentPhases = phases.filter(p => {
            if (p.securityScan)
                return false;
            if (p.docOnly)
                return false;
            if (spec.workspace === 'isolated' && isCommitPushPhaseId(sanitizeId(p.name)))
                return false;
            return !p.dependsOn || p.dependsOn.length === 0;
        });
        this._hasFanOut = this._independentPhases.length >= 2 && !phases.some(p => p.competing);
        this._hasCompeting = phases.some(p => p.competing);
        this._hasConvergence = !!spec.convergence;
        let specDriven = 'NONE';
        if (hasBDD && hasSpecFile)
            specDriven = 'spec_file + BDD + conformance';
        else if (hasBDD)
            specDriven = 'BDD + conformance';
        else if (hasSpecFile)
            specDriven = 'spec_file + conformance';
        else if (hasSpecFirstAny)
            specDriven = 'conformance';
        this._defenseMatrix = {
            competitive: this._hasCompeting,
            guardrails: [],
            specDriven,
            permissions: [],
            adversarial: hasRedTeam,
        };
        this._graphAttrs = {
            label: this._hasConvergence ? escapeAttr(this._slug) : escapeAttr(`${this._slug}: ${this._goal}`),
            rankdir: 'LR',
            goal: escapeAttr(this._goal),
            retry_target: this._hasConvergence ? 'converge' : 'fix_types',
        };
        if (spec.workingDir)
            this._graphAttrs['working_dir'] = escapeAttr(spec.workingDir);
        if (spec.specFile)
            this._graphAttrs['spec_file'] = escapeAttr(spec.specFile);
        if (spec.defaultMaxRetry)
            this._graphAttrs['default_max_retry'] = String(spec.defaultMaxRetry);
        if (spec.workspace === 'isolated') {
            this._graphAttrs['workspace'] = 'isolated';
            this._applied.add('P0');
        }
        if (spec.modelStylesheet)
            this._graphAttrs['model_stylesheet'] = this._buildStylesheet(spec.modelStylesheet);
        const mergedAc = this._mergedAcceptanceCriteria();
        const acKeys = Object.keys(mergedAc).sort();
        if (acKeys.length > 0) {
            this._graphAttrs['acceptance_criteria'] = escapeAttr(acKeys.map(k => `context.${k}=${String(mergedAc[k])}`).join(' && '));
        }
        this._emit('start', { shape: 'Mdiamond' });
        this._emit('setup_deps', {
            label: 'setup_deps',
            shape: 'parallelogram',
            tool_command: 'cd ${WORKING_DIR} && npm install 2>&1 || pnpm install 2>&1 || yarn install 2>&1',
        });
        this._applied.add('P0a');
        this._emit('capture_baseline', {
            label: 'capture_baseline',
            read_only: 'true',
            shape: 'parallelogram',
            tool_command: "cd ${WORKING_DIR} && (npx tsc --noEmit 2>&1 | grep -c 'error TS' > /tmp/baseline_ts_errors.txt || echo 0 > /tmp/baseline_ts_errors.txt) && (npx eslint src/ 2>&1 | grep -c 'error' > /tmp/baseline_lint_errors.txt || echo 0 > /tmp/baseline_lint_errors.txt)",
        });
        this._applied.add('P0c');
        this._link('start', 'setup_deps');
        this._link('setup_deps', 'capture_baseline');
        this._implPhases = phases.filter(p => !p.securityScan && !p.docOnly);
        const allDependentPhases = phases.filter(p => !p.securityScan);
        const rawUnionPaths = [...new Set(allDependentPhases.flatMap(p => p.allowedPaths ?? []))];
        this._unionPaths = expandWithTestDirs(rawUnionPaths).join(',');
        this._unionEscalate = [...new Set(allDependentPhases.flatMap(p => p.escalateOn ?? []))].join(',');
        const tier1Keys = {};
        for (const p of phases) {
            if (p.contextOnSuccess) {
                for (const [k, v] of Object.entries(p.contextOnSuccess))
                    tier1Keys[k] = v;
            }
        }
        this._verifyTypecheckKV = { types_compile: 'true' };
        this._verifyLintKV = { lint_clean: 'true' };
        this._verifyTestsKV = {
            cli_contract: 'true', determinism: 'true', tests_pass: 'true', validation_rules: 'true',
            ...tier1Keys,
        };
    }
    _emit(id, attrs) {
        this._nodes.push(`  ${id} [${fmtAttrs(attrs)}]`);
        this._nodeMap.set(id, { ...attrs });
    }
    _link(from, to, attrs) {
        const edgeLine = (attrs && Object.keys(attrs).length > 0)
            ? `  ${from} -> ${to} [${fmtAttrs(attrs)}]`
            : `  ${from} -> ${to}`;
        if (this._seenEdges.has(edgeLine))
            return;
        this._seenEdges.add(edgeLine);
        this._edges.push(edgeLine);
        if (attrs && Object.keys(attrs).length > 0)
            this._edgeList.push({ from, to, label: attrs['label'], attrs });
        else
            this._edgeList.push({ from, to });
    }
    _emitSubgraph(clusterId, label, bodyEmitter) {
        const prevNodesLen = this._nodes.length;
        const prevEdgesLen = this._edges.length;
        bodyEmitter();
        const bodyNodes = this._nodes.splice(prevNodesLen);
        const bodyEdges = this._edges.splice(prevEdgesLen);
        this._subgraphBlocks.push(`  subgraph cluster_${clusterId} {`);
        this._subgraphBlocks.push(`    label="${escapeAttr(label)}"`);
        for (const n of bodyNodes)
            this._subgraphBlocks.push(`  ${n}`);
        for (const e of bodyEdges)
            this._subgraphBlocks.push(`  ${e}`);
        this._subgraphBlocks.push('  }');
    }
    _emitEndgameChain(prevId, prevAttrs) {
        const spec = this._spec;
        const unionPaths = this._unionPaths;
        const unionEscalate = this._unionEscalate;
        const verifyTypecheckKV = this._verifyTypecheckKV;
        const verifyLintKV = this._verifyLintKV;
        const verifyTestsKV = this._verifyTestsKV;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        // audit: diagnostic node, never fails (|| true on all commands)
        emit('audit', {
            label: 'audit',
            read_only: 'true',
            shape: 'parallelogram',
            tool_command: "cd ${WORKING_DIR} && (npx tsc --noEmit 2>&1 || true) && (npx eslint src/ --max-warnings=0 2>&1 || true) && (npm test 2>&1 || true)",
        });
        link(prevId, 'audit', prevAttrs);
        let chainPrev = 'audit';
        // Optional fix_all broad pass (only when endgame.broadPass=true)
        if (spec.endgame?.broadPass) {
            const fixAllAttrs = {
                allowed_paths: unionPaths,
                class: 'codergen',
                label: 'fix_all',
                max_visits: '2',
                permission_mode: 'auto',
                timeout: '30m',
            };
            if (unionEscalate)
                fixAllAttrs['escalate_on'] = unionEscalate;
            emit('fix_all', fixAllAttrs);
            link('audit', 'fix_all');
            chainPrev = 'fix_all';
        }
        // verify_typecheck <-> fix_types
        emit('verify_typecheck', {
            context_on_success: serializeKV(verifyTypecheckKV),
            label: 'verify_typecheck',
            max_visits: '5',
            retry_target: 'fix_types',
            shape: 'parallelogram',
            timeout: '30m',
            tool_command: 'cd ${WORKING_DIR} && npx tsc --noEmit',
        });
        emit('fix_types', {
            allowed_paths: unionPaths,
            class: 'codergen',
            escalate_on: unionEscalate || DEFAULT_ESCALATE_ON,
            label: 'Fix ONLY type errors reported by tsc --noEmit',
            max_visits: '5',
            permission_mode: 'auto',
            timeout: '30m',
        });
        link(chainPrev, 'verify_typecheck');
        link('verify_typecheck', 'fix_types', { condition: 'outcome=fail', label: 'fail' });
        link('fix_types', 'verify_typecheck');
        // verify_lint <-> fix_lint
        emit('verify_lint', {
            context_on_success: serializeKV(verifyLintKV),
            label: 'verify_lint',
            max_visits: '5',
            retry_target: 'fix_lint',
            shape: 'parallelogram',
            timeout: '30m',
            tool_command: 'cd ${WORKING_DIR} && npx eslint src/ --max-warnings=0',
        });
        emit('fix_lint', {
            allowed_paths: unionPaths,
            class: 'codergen',
            escalate_on: unionEscalate || DEFAULT_ESCALATE_ON,
            label: 'Fix ONLY lint errors reported by eslint',
            max_visits: '5',
            permission_mode: 'auto',
            timeout: '30m',
        });
        link('verify_typecheck', 'verify_lint', { condition: 'outcome=success', label: 'pass' });
        link('verify_lint', 'fix_lint', { condition: 'outcome=fail', label: 'fail' });
        link('fix_lint', 'verify_lint');
        // verify_tests <-> fix_tests
        emit('verify_tests', {
            context_on_success: serializeKV(verifyTestsKV),
            label: 'verify_tests',
            max_visits: '5',
            retry_target: 'fix_tests',
            shape: 'parallelogram',
            timeout: '30m',
            tool_command: 'cd ${WORKING_DIR} && npm test',
        });
        emit('fix_tests', {
            allowed_paths: unionPaths,
            class: 'codergen',
            escalate_on: unionEscalate || DEFAULT_ESCALATE_ON,
            label: 'Fix ONLY failing tests reported by npm test',
            max_visits: '5',
            permission_mode: 'auto',
            timeout: '30m',
        });
        link('verify_lint', 'verify_tests', { condition: 'outcome=success', label: 'pass' });
        link('verify_tests', 'fix_tests', { condition: 'outcome=fail', label: 'fail' });
        link('fix_tests', 'verify_tests');
        // regression_check — full suite re-run, failure routes to fix_types
        emit('regression_check', {
            label: 'regression_check',
            shape: 'parallelogram',
            timeout: '30m',
            tool_command: 'cd ${WORKING_DIR} && npx tsc --noEmit && npx eslint src/ --max-warnings=0 && npm test',
        });
        link('verify_tests', 'regression_check', { condition: 'outcome=success', label: 'pass' });
        link('regression_check', 'fix_types', { condition: 'outcome=fail', label: 'fail' });
        // quality_review gate
        emit('quality_review', {
            class: 'review',
            label: 'Final quality review: verify all acceptance criteria met, no regressions, code is clean. Output STATUS: SUCCESS | FAIL.',
            read_only: 'true',
            timeout: '15m',
        });
        link('regression_check', 'quality_review', { condition: 'outcome=success', label: 'pass' });
        link('quality_review', 'exit', { condition: 'outcome=success', label: 'pass' });
        link('quality_review', 'fix_types', { condition: 'outcome=fail', label: 'fail' });
    }
    _emitFanOutTopology() {
        const phases = this._phases;
        const independent = this._independentPhases;
        const applied = this._applied;
        const nodes = this._nodes;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        const emitEndgameChain = this._emitEndgameChain.bind(this);
        applied.add('P4');
        emit('split_phases', { label: 'split_phases', max_parallel: '1', shape: 'component' });
        applied.add('P0b');
        link('capture_baseline', 'split_phases');
        for (const p of independent) {
            const phaseIdx = phases.indexOf(p) + 1;
            const id = sanitizeId(p.name);
            const threadId = p.threadId ?? `phase_${phaseIdx}`;
            nodes.push(`  // ========== PHASE ${phaseIdx}: ${id} ==========`);
            emit(id, { label: p.name, shape: 'component', thread_id: threadId });
            link('split_phases', id);
        }
        const dependent = phases.filter(p => p.dependsOn && p.dependsOn.length > 0);
        const mergeId = 'merge_phases';
        emit(mergeId, { label: 'merge_phases', shape: 'tripleoctagon' });
        for (const p of independent)
            link(sanitizeId(p.name), mergeId);
        let afterMerge = mergeId;
        for (const p of dependent) {
            const phaseIdx = phases.indexOf(p) + 1;
            const id = sanitizeId(p.name);
            const threadId = p.threadId ?? `phase_${phaseIdx}`;
            nodes.push(`  // ========== PHASE ${phaseIdx}: ${id} ==========`);
            emit(id, { label: p.name, shape: 'component', thread_id: threadId });
            link(afterMerge, id);
            afterMerge = id;
        }
        // P21: disaggregated verify/fix endgame chain
        applied.add('P21');
        emitEndgameChain(afterMerge);
    }
    _emitCompetingTopology() {
        const phases = this._phases;
        const applied = this._applied;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        // Competing implementations (Pattern 18)
        applied.add('P18');
        const cp = phases.find(p => p.competing);
        const baseId = sanitizeId(cp.name);
        emit(`${baseId}_a`, { label: `${cp.name} A`, max_parallel: '1', shape: 'component' });
        emit(`${baseId}_b`, { label: `${cp.name} B`, max_parallel: '1', shape: 'component' });
        emit('competing_merge', { label: 'competing_merge', shape: 'tripleoctagon' });
        link('capture_baseline', `${baseId}_a`);
        link('capture_baseline', `${baseId}_b`);
        link(`${baseId}_a`, 'competing_merge');
        link(`${baseId}_b`, 'competing_merge');
        link('competing_merge', 'exit');
    }
    // eslint-disable-next-line complexity -- HT-1 reviewed: convergence topology mirrors the schema in one emission pass.
    _emitConvergenceTopology() {
        const spec = this._spec;
        const applied = this._applied;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        const emitSubgraph = this._emitSubgraph.bind(this);
        // Convergence mode: v8 topology — 10-node body + fp/repro post-chain + done terminal.
        const cv = spec.convergence;
        const fb = cv.fixBackend;
        const ff = cv.fixFrontend;
        const mg = cv.mechanicalGates;
        const rv = cv.reviewers;
        const adv = cv.adversary;
        const fp = cv.fpVerify;
        const rp = cv.reproVerify;
        const wd = spec.workingDir ?? '${WORKING_DIR}';
        const sub = (cmd) => cmd.split('/repos/benchmark').join(wd);
        const fbHarness = fb?.harness ?? cv.impl.harness ?? DEFAULT_FIX_BACKEND_HARNESS;
        const ffHarness = ff?.harness ?? cv.impl.harness ?? DEFAULT_FIX_FRONTEND_HARNESS;
        const advSealed = adv?.sealedFromSource ?? cv.sealedFromSource ?? DEFAULT_ADVERSARY_SEALED_FROM_SOURCE;
        emit('converge', {
            body: 'iter-body',
            class: 'iterate',
            convergence_epsilon: String(cv.convergenceEpsilon ?? DEFAULT_CONVERGENCE_EPSILON),
            label: 'converge',
            max_iterations: String(cv.maxIterations ?? DEFAULT_MAX_ITERATIONS),
            max_visits: String(cv.maxVisits ?? DEFAULT_CONVERGE_MAX_VISITS),
            retry_target: 'converge',
            shape: 'house',
            timeout: cv.timeout ?? DEFAULT_CONVERGE_TIMEOUT,
            until: cv.until,
        });
        link('capture_baseline', 'converge');
        // eslint-disable-next-line complexity -- HT-1 reviewed: subgraph callback emits fixed convergence body nodes.
        emitSubgraph('iter_body', 'iter-body', () => {
            emit('fix_backend', {
                allow_multi_retry_target: 'true',
                class: 'impl',
                context_keys: '__pool_findings__,__last_failure_output,__fix_attempt_history',
                harness: fbHarness,
                max_visits: String(fb?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: fb?.model ?? DEFAULT_FIX_BACKEND_MODEL,
                prompt: fb?.prompt ?? DEFAULT_FIX_BACKEND_PROMPT,
                retry_target: 'fix_backend',
                timeout: fb?.timeout ?? DEFAULT_FIX_TIMEOUT,
            });
            emit('fix_frontend', {
                class: 'impl',
                context_keys: '__pool_findings__,__last_failure_output,__fix_attempt_history',
                harness: ffHarness,
                max_visits: String(ff?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: ff?.model ?? DEFAULT_FIX_FRONTEND_MODEL,
                prompt: ff?.prompt ?? DEFAULT_FIX_FRONTEND_PROMPT,
                retry_target: 'fix_frontend',
                timeout: ff?.timeout ?? DEFAULT_FIX_TIMEOUT,
            });
            emit('run_build_api', {
                max_visits: String(DEFAULT_MECHANICAL_MAX_VISITS),
                reports_to_v: 'mechanical.typecheck',
                retry_target: 'fix_backend',
                shape: 'parallelogram',
                timeout: DEFAULT_MECHANICAL_BUILD_TIMEOUT,
                tool_command: mg?.buildApi ?? sub(DEFAULT_BUILD_API_CMD),
            });
            emit('run_tests_api', {
                max_visits: String(DEFAULT_MECHANICAL_MAX_VISITS),
                reports_to_v: 'mechanical.boot',
                retry_target: 'fix_backend',
                shape: 'parallelogram',
                timeout: DEFAULT_MECHANICAL_TESTS_TIMEOUT,
                tool_command: mg?.testsApi ?? sub(DEFAULT_TESTS_API_CMD),
            });
            emit('run_build_ui', {
                max_visits: String(DEFAULT_MECHANICAL_MAX_VISITS),
                reports_to_v: 'mechanical.build',
                retry_target: 'fix_frontend',
                shape: 'parallelogram',
                timeout: DEFAULT_MECHANICAL_BUILD_TIMEOUT,
                tool_command: mg?.buildUi ?? sub(DEFAULT_BUILD_UI_CMD),
            });
            emit('run_lint', {
                max_visits: String(DEFAULT_MECHANICAL_MAX_VISITS),
                reports_to_v: 'mechanical.lint',
                retry_target: 'fix_backend',
                shape: 'parallelogram',
                timeout: DEFAULT_MECHANICAL_BUILD_TIMEOUT,
                tool_command: mg?.lint ?? sub(DEFAULT_LINT_CMD),
            });
            emit('review_be', {
                class: 'honest_review',
                harness: rv?.be?.harness ?? 'hermes',
                max_visits: String(rv?.be?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: rv?.be?.model ?? DEFAULT_REVIEW_BE_MODEL,
                prompt: rv?.be?.prompt ?? DEFAULT_REVIEW_BE_PROMPT,
                read_only: 'true',
                retry_target: 'review_be',
                reviewer_lens: 'backend',
                timeout: rv?.be?.timeout ?? DEFAULT_REVIEW_TIMEOUT,
            });
            emit('review_fe', {
                class: 'honest_review',
                harness: rv?.fe?.harness ?? 'hermes',
                max_visits: String(rv?.fe?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: rv?.fe?.model ?? DEFAULT_REVIEW_FE_MODEL,
                prompt: rv?.fe?.prompt ?? DEFAULT_REVIEW_FE_PROMPT,
                read_only: 'true',
                retry_target: 'review_fe',
                reviewer_lens: 'frontend',
                timeout: rv?.fe?.timeout ?? DEFAULT_REVIEW_TIMEOUT,
            });
            emit('review_int', {
                class: 'honest_review',
                harness: rv?.int?.harness ?? 'hermes',
                max_visits: String(rv?.int?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: rv?.int?.model ?? DEFAULT_REVIEW_INT_MODEL,
                prompt: rv?.int?.prompt ?? DEFAULT_REVIEW_INT_PROMPT,
                read_only: 'true',
                retry_target: 'review_int',
                reviewer_lens: 'integration',
                timeout: rv?.int?.timeout ?? DEFAULT_REVIEW_TIMEOUT,
            });
            emit('adversary_node', {
                class: 'adversary',
                harness: adv?.harness ?? 'hermes',
                max_visits: String(adv?.maxVisits ?? DEFAULT_BODY_MAX_VISITS),
                model: adv?.model ?? DEFAULT_ADVERSARY_MODEL,
                prompt: adv?.prompt ?? DEFAULT_ADVERSARY_PROMPT,
                read_only: 'true',
                sealed_from_source: advSealed,
                timeout: adv?.timeout ?? DEFAULT_REVIEW_TIMEOUT,
            });
            const bodyChain = [
                'fix_backend', 'fix_frontend',
                'run_build_api', 'run_tests_api', 'run_build_ui', 'run_lint',
                'review_be', 'review_fe', 'review_int', 'adversary_node',
            ];
            for (let bi = 0; bi < bodyChain.length - 1; bi++) {
                link(bodyChain[bi], bodyChain[bi + 1], { condition: 'outcome=success', label: 'pass' });
            }
        });
        // Goal-gate nodes live OUTSIDE cluster_iter_body.
        emit('fp_verify', {
            context_on_failure: 'fp_pass=false',
            context_on_success: 'fp_pass=true',
            goal_gate: 'true',
            max_visits: String(fp?.maxVisits ?? DEFAULT_GOAL_GATE_MAX_VISITS),
            shape: 'parallelogram',
            timeout: fp?.timeout ?? DEFAULT_GOAL_GATE_TIMEOUT,
            tool_command: fp?.command ?? sub(DEFAULT_FP_VERIFY_CMD),
        });
        emit('repro_verify', {
            context_on_failure: 'repro_pass=false',
            context_on_success: 'repro_pass=true',
            goal_gate: 'true',
            max_visits: String(rp?.maxVisits ?? DEFAULT_GOAL_GATE_MAX_VISITS),
            shape: 'parallelogram',
            timeout: rp?.timeout ?? DEFAULT_GOAL_GATE_TIMEOUT,
            tool_command: rp?.command ?? sub(DEFAULT_REPRO_VERIFY_CMD),
        });
        emit('done', { label: 'done', shape: 'Msquare' });
        // Post-chain: body exit → fp → repro → done, with fail bounces.
        link('adversary_node', 'fp_verify');
        link('fp_verify', 'repro_verify', { condition: 'outcome=success', label: 'pass' });
        link('repro_verify', 'done', { condition: 'outcome=success', label: 'pass' });
        link('fp_verify', 'converge', { condition: 'outcome=fail', label: 'fail' });
        link('repro_verify', 'fp_verify', { condition: 'outcome=fail', label: 'fail' });
        // Reachability edges from the iterate header.
        link('converge', 'fix_backend', { condition: 'outcome=success', weight: '1' });
        link('converge', 'fp_verify', { condition: 'outcome=success', weight: '2' });
        applied.add('P32');
    }
    // eslint-disable-next-line complexity, max-lines-per-function -- HT-1 reviewed: sequential DOT emission is a schema-to-graph table.
    _emitSequentialPhases() {
        const spec = this._spec;
        const phases = this._phases;
        const applied = this._applied;
        const nodes = this._nodes;
        const nodeMap = this._nodeMap;
        const implPhases = this._implPhases;
        const emittedDiagnostics = this._emittedDiagnostics;
        const defenseMatrix = this._defenseMatrix;
        const hasConvergence = this._hasConvergence;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        const emitEndgameChain = this._emitEndgameChain.bind(this);
        // Sequential execution
        const hasAnyPhase = phases.length > 0;
        let prevId = 'capture_baseline';
        let prevAttrs = undefined;
        if (hasConvergence) {
            this._emitConvergenceTopology();
            prevId = 'done';
            prevAttrs = {};
        }
        for (let i = 0; i < phases.length && !hasConvergence; i++) {
            const p = phases[i];
            const id = sanitizeId(p.name);
            const threadId = p.threadId ?? `phase_${i + 1}`;
            nodes.push(`  // ========== PHASE ${i + 1}: ${id} ==========`);
            const emitSpec = !p.securityScan && !p.docOnly && (p.specFirst === true || (p.goalGate && p.specFirst !== false));
            const emitBDD = !p.securityScan && !p.docOnly && p.bddScenarios === true;
            const specId = `spec_file_${id}`;
            const bddId = `bdd_scenarios_${id}`;
            // securityScan: simple review pass-through
            if (p.securityScan) {
                const phaseAttrs = {
                    class: 'review',
                    label: p.prompt,
                    read_only: 'true',
                    thread_id: threadId,
                };
                applied.add('P6b');
                applied.add('P8');
                emit(id, phaseAttrs);
                link(prevId, id, prevAttrs);
                prevId = id;
                prevAttrs = undefined;
                continue;
            }
            const implId = `impl_${id}`;
            const scopeCheckId = `scope_check_${id}`;
            const checkProgressId = `check_progress_${id}`;
            const conformanceId = `conformance_${id}`;
            // docOnly phase
            if (p.docOnly) {
                const implAttrs = {
                    allowed_paths: expandWithTestDirs(p.allowedPaths ?? []).join(','),
                    class: 'documentation',
                    label: p.prompt,
                    max_visits: '5',
                    thread_id: threadId,
                };
                if (p.timeout)
                    implAttrs['timeout'] = p.timeout;
                link(prevId, implId, prevAttrs);
                emit(implId, implAttrs);
                applied.add('P22');
                applied.add('P6');
                emit(checkProgressId, {
                    label: 'check_progress',
                    max_visits: '3',
                    read_only: 'true',
                    shape: 'parallelogram',
                    thread_id: threadId,
                    tool_command: "cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'",
                });
                applied.add('P0e');
                link(implId, checkProgressId);
                link(checkProgressId, 'exit', { condition: 'outcome=fail', label: 'fail' });
                emit(scopeCheckId, {
                    class: 'review',
                    label: 'Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS | FAIL.',
                    read_only: 'true',
                    shape: 'parallelogram',
                    thread_id: threadId,
                });
                applied.add('P10');
                applied.add('P6b');
                link(checkProgressId, scopeCheckId);
                link(scopeCheckId, 'exit', { condition: 'outcome=fail', label: 'fail' });
                const conformanceDocAttrs = {
                    class: 'review',
                    label: 'Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS | FAIL.',
                    read_only: 'true',
                    thread_id: threadId,
                    timeout: '15m',
                };
                emit(conformanceId, conformanceDocAttrs);
                applied.add('P15');
                link(scopeCheckId, conformanceId);
                prevId = conformanceId;
                prevAttrs = undefined;
                continue;
            }
            // Regular impl phase
            // UI completeness injection: auto-append defaults for known uiType values
            const reqs = [...(p.requirements ?? [])];
            if (p.uiType) {
                const uiDefaults = UI_REQUIREMENTS[p.uiType] ?? [];
                for (const def of uiDefaults) {
                    if (!reqs.some(r => r.toLowerCase().includes(def.toLowerCase()))) {
                        reqs.push(def);
                    }
                }
            }
            const testId = `test_${id}`;
            const fixId = `fix_${id}`;
            const verifyLintId = `verify_lint_${id}`;
            const verifyTypesId = `verify_types_${id}`;
            // Spec-first gates (P16 / P16b)
            if (emitBDD && emitSpec) {
                const bddLabel = reqs.length > 0
                    ? `Review BDD scenarios against phase prompt. Verify ${reqs.length} scenarios with Given/When/Then covering: ${formatRequirementsList(reqs)}. Output STATUS: SUCCESS | FAIL.`
                    : 'Review BDD scenarios against phase prompt. Verify each scenario has Given/When/Then. Output STATUS: SUCCESS | FAIL.';
                emit(bddId, {
                    class: 'review',
                    label: bddLabel,
                    read_only: 'true',
                    thread_id: threadId,
                    timeout: '15m',
                });
                const specLabelBDD = reqs.length > 0
                    ? `Review spec file. Verify ${reqs.length} machine-checkable acceptance criteria for: ${formatRequirementsList(reqs)}. Output STATUS: SUCCESS | FAIL.`
                    : 'Review spec file against phase prompt and BDD scenarios. Verify acceptance criteria are machine-checkable. Output STATUS: SUCCESS | FAIL.';
                emit(specId, {
                    class: 'review',
                    label: specLabelBDD,
                    read_only: 'true',
                    thread_id: threadId,
                    timeout: '15m',
                });
                link(prevId, bddId, prevAttrs);
                link(bddId, specId);
                link(specId, implId);
                applied.add('P16b');
                applied.add('P16');
            }
            else if (emitSpec) {
                const specLabel = reqs.length > 0
                    ? `Review spec file. Verify ${reqs.length} machine-checkable acceptance criteria for: ${formatRequirementsList(reqs)}. Output STATUS: SUCCESS | FAIL.`
                    : 'Review spec file against phase prompt. Verify acceptance criteria are machine-checkable. Output STATUS: SUCCESS | FAIL.';
                emit(specId, {
                    class: 'review',
                    label: specLabel,
                    read_only: 'true',
                    thread_id: threadId,
                    timeout: '15m',
                });
                link(prevId, specId, prevAttrs);
                link(specId, implId);
                applied.add('P16');
            }
            else {
                link(prevId, implId, prevAttrs);
            }
            // P22: impl node
            const implAttrs = {
                allowed_paths: expandWithTestDirs(p.allowedPaths ?? []).join(','),
                class: 'codergen',
                label: p.prompt,
                max_visits: '5',
                permission_mode: 'auto',
                thread_id: threadId,
            };
            implAttrs['escalate_on'] = (p.escalateOn && p.escalateOn.length > 0) ? p.escalateOn.join(',') : DEFAULT_ESCALATE_ON;
            implAttrs['timeout'] = p.timeout ?? '30m';
            if (p.deliverables && p.deliverables.length > 0) {
                implAttrs['deliverables'] = p.deliverables.join(',');
            }
            if (spec.workspace === 'isolated' && isCommitPushPhaseId(id)) {
                if (spec.workspaceOpts?.repoUrl)
                    implAttrs['repo_url'] = spec.workspaceOpts.repoUrl;
                if (spec.workspaceOpts?.cleanup)
                    implAttrs['cleanup'] = spec.workspaceOpts.cleanup;
            }
            emit(implId, implAttrs);
            applied.add('P22');
            applied.add('P6');
            if (!defenseMatrix.permissions.includes('auto')) {
                defenseMatrix.permissions.push('auto');
            }
            // P10: scope_check
            emit(scopeCheckId, {
                class: 'review',
                label: 'Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS | FAIL.',
                read_only: 'true',
                shape: 'parallelogram',
                thread_id: threadId,
            });
            applied.add('P10');
            applied.add('P6b');
            link(implId, scopeCheckId);
            // P0e: check_progress
            emit(checkProgressId, {
                label: 'check_progress',
                max_visits: '3',
                read_only: 'true',
                shape: 'parallelogram',
                thread_id: threadId,
                tool_command: "cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'",
            });
            applied.add('P0e');
            // Test isolation gate: when testExpectations.isolation === true, insert between scope_check and check_progress
            if (p.testExpectations?.isolation === true) {
                const testIsolationId = `test_isolation_${id}`;
                const testPaths = expandWithTestDirs(p.allowedPaths ?? [])
                    .filter(tp => tp.startsWith('tests/') || tp.startsWith('__tests__/'))
                    .join(' ');
                emit(testIsolationId, {
                    label: 'Verify test isolation: beforeEach/afterEach present in test files',
                    shape: 'parallelogram',
                    thread_id: threadId,
                    tool_command: `grep -rl 'beforeEach\\|afterEach' ${testPaths || '.'} && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'`,
                });
                link(scopeCheckId, testIsolationId);
                link(testIsolationId, checkProgressId);
            }
            else {
                link(scopeCheckId, checkProgressId);
            }
            // P13: verify_lint
            emit(verifyLintId, {
                label: 'verify_lint: BASELINE from cat baseline_lint_errors; CURRENT lint error count -le BASELINE',
                shape: 'parallelogram',
                thread_id: threadId,
                tool_command: '[ $(npx eslint src/ 2>&1 | grep -c error || echo 0) -le $(cat /tmp/baseline_lint_errors.txt 2>/dev/null || echo 0) ]',
            });
            applied.add('P13');
            applied.add('P0d');
            link(checkProgressId, verifyLintId);
            // P14: verify_types
            emit(verifyTypesId, {
                label: 'verify_types: BASELINE from cat baseline_ts_errors; CURRENT TS error count -le BASELINE',
                thread_id: threadId,
                tool_command: '[ $(npx tsc --noEmit 2>&1 | grep -c error || echo 0) -le $(cat /tmp/baseline_ts_errors.txt 2>/dev/null || echo 0) ]',
            });
            applied.add('P14');
            link(verifyLintId, verifyTypesId);
            // P9: optional coverage gate
            const hasCoverage = typeof p.coverageTarget === 'number';
            if (hasCoverage) {
                const testRunId = `test_run_${id}`;
                const covId = `coverage_gate_${id}`;
                emit(testRunId, { label: 'test' });
                emit(covId, { coverage_target: String(p.coverageTarget), label: 'coverage_gate', shape: 'diamond' });
                applied.add('P9');
                link(verifyTypesId, testRunId);
                link(testRunId, covId);
                link(covId, conformanceId, { condition: 'outcome=success', label: 'pass' });
                link(covId, implId, { condition: 'outcome=fail', label: 'fail' });
            }
            else {
                link(verifyTypesId, conformanceId);
            }
            // P15: conformance
            const conformanceLabel = reqs.length > 0
                ? `Verify these ${reqs.length} requirements in git diff: ${formatRequirementsList(reqs)}. Check: correct files modified, API contracts match. Output STATUS: SUCCESS | FAIL.`
                : 'Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS | FAIL.';
            const conformanceAttrs = {
                class: 'review',
                label: conformanceLabel,
                read_only: 'true',
                thread_id: threadId,
                timeout: '15m',
            };
            if (p.contextOnSuccess) {
                conformanceAttrs['context_on_success'] = serializeKV(p.contextOnSuccess);
            }
            if (p.goalGate) {
                conformanceAttrs['goal_gate'] = 'true';
                applied.add('P2');
                conformanceAttrs['max_visits'] = String(spec.defaultMaxRetry ?? 3);
                // Auto-populate verifies from upstream deliverables
                const upstreamDeliverables = new Set();
                if (p.deliverables)
                    p.deliverables.forEach(d => upstreamDeliverables.add(d));
                if (p.dependsOn) {
                    for (const depName of p.dependsOn) {
                        const dep = phases.find(pp => pp.name === depName);
                        if (dep?.deliverables)
                            dep.deliverables.forEach(d => upstreamDeliverables.add(d));
                    }
                }
                if (upstreamDeliverables.size > 0) {
                    conformanceAttrs['verifies'] = [...upstreamDeliverables].sort().join(',');
                }
            }
            emit(conformanceId, conformanceAttrs);
            applied.add('P15');
            // P1: test diamond
            const testAttrs = {
                label: `test ${id}`,
                retry_target: implId,
                shape: 'diamond',
            };
            if (!p.goalGate) {
                testAttrs['max_visits'] = p.testExpectations?.count !== undefined
                    ? String(computeMaxVisits(p.testExpectations.count))
                    : '5';
                applied.add('P6');
            }
            else if (spec.defaultMaxRetry) {
                testAttrs['max_visits'] = String(spec.defaultMaxRetry);
                applied.add('P6');
            }
            else {
                testAttrs['max_visits'] = p.testExpectations?.count !== undefined
                    ? String(computeMaxVisits(p.testExpectations.count))
                    : '3';
                applied.add('P6');
            }
            emit(testId, testAttrs);
            applied.add('P1');
            applied.add('P3');
            link(conformanceId, testId);
            // P1: fix loop
            emit(fixId, {
                allowed_paths: expandWithTestDirs(p.allowedPaths ?? []).join(','),
                class: 'codergen',
                escalate_on: (p.escalateOn && p.escalateOn.length > 0) ? p.escalateOn.join(',') : DEFAULT_ESCALATE_ON,
                label: `fix ${id}`,
                max_visits: '5',
                permission_mode: 'auto',
                thread_id: threadId,
                timeout: '30m',
            });
            link(testId, fixId, { condition: 'outcome=fail', label: 'fail' });
            link(fixId, implId);
            // P17: red_team after test pass (RT-5: fail→fix, success→next)
            if (p.redTeam) {
                const rtId = `red_team_${id}`;
                emit(rtId, { class: 'review', label: 'Red-team the implementation: attempt to break it via edge cases, malformed input, concurrency, and security probes. Output STATUS: SUCCESS | FAIL.', read_only: 'true', thread_id: threadId, timeout: '15m' });
                applied.add('P17');
                link(testId, rtId, { condition: 'outcome=success', label: 'pass' });
                link(rtId, fixId, { condition: 'outcome=fail', label: 'fail' });
                prevId = rtId;
                prevAttrs = { condition: 'outcome=success', label: 'pass' };
            }
            else {
                prevId = testId;
                prevAttrs = { condition: 'outcome=success', label: 'pass' };
            }
            // Diagnostic: warn when a complex phase has no structured requirements
            if ((!p.requirements || p.requirements.length === 0) && (p.allowedPaths ?? []).length >= 4) {
                emittedDiagnostics.push(mkDiag('MISSING_REQUIREMENTS', 'warning', `Phase "${p.name}" has ${(p.allowedPaths ?? []).length} allowed paths but no structured requirements — gates cannot verify specific deliverables`, implId));
            }
        }
        // Deliverables coverage diagnostic: warn when deliverables lack matching verifies
        const allDeliverables = new Set();
        const allVerifies = new Set();
        for (const p of implPhases) {
            if (p.deliverables)
                p.deliverables.forEach(d => allDeliverables.add(d));
        }
        // Collect verifies from emitted goal_gate nodes
        for (const [, attrs] of nodeMap) {
            if (attrs['goal_gate'] === 'true' && attrs['verifies']) {
                attrs['verifies'].split(',').forEach(v => allVerifies.add(v.trim()));
            }
        }
        for (const d of allDeliverables) {
            if (!allVerifies.has(d)) {
                emittedDiagnostics.push(mkDiag('DELIVERABLES_COVERAGE', 'warning', `Deliverable "${d}" has no matching verifies in any goal_gate node`, undefined));
            }
        }
        for (const v of allVerifies) {
            if (!allDeliverables.has(v)) {
                emittedDiagnostics.push(mkDiag('DELIVERABLES_COVERAGE', 'warning', `Verifies entry "${v}" on goal_gate does not match any phase deliverable`, undefined));
            }
        }
        // P21: disaggregated verify/fix endgame chain (suppressed by convergence — iterate handles its own exit)
        if (hasAnyPhase && !hasConvergence) {
            applied.add('P21');
            emitEndgameChain(prevId, prevAttrs);
        }
        else if (spec.microverse) {
            // Zero-phase + microverse: route into the microverse loop, not directly to exit
            link('capture_baseline', 'commit_baseline');
        }
        else if (!hasConvergence) {
            link('capture_baseline', 'exit');
        }
    }
    _emitMicroverseLoop() {
        const spec = this._spec;
        const phases = this._phases;
        const applied = this._applied;
        const standaloneNodeIds = this._standaloneNodeIds;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        if (!spec.microverse)
            return;
        applied.add('P20');
        const mv = spec.microverse;
        const mvOpts = mv.opts;
        emit('commit_baseline', { label: 'commit_baseline', shape: 'parallelogram' });
        emit('baseline', { label: `baseline ${mv.name}`, shape: 'parallelogram' });
        emit('optimize', { label: `optimize ${mv.name}` });
        emit('measure', { label: `measure ${mv.name}` });
        emit('compare', {
            direction: mvOpts.direction ?? 'improve',
            label: 'compare',
            max_visits: String(mvOpts.maxVisits ?? 10),
            shape: 'diamond',
            target: String(mvOpts.target),
        });
        emit('check', { label: 'check', shape: 'diamond' });
        link('commit_baseline', 'baseline');
        link('baseline', 'optimize');
        link('optimize', 'measure');
        link('measure', 'compare');
        link('compare', 'optimize', { condition: 'outcome=miss', label: 'miss' });
        link('compare', 'check', { condition: 'outcome=hit', label: 'hit' });
        link('check', 'exit', { condition: 'outcome=accept', label: 'accept' });
        link('check', 'optimize', { condition: 'outcome=reject', label: 'reject' });
        // Microverse is standalone (exempt from reachability check) ONLY when phases exist.
        // In zero-phase mode, microverse IS the main pipeline — connected via capture_baseline.
        if (phases.length > 0) {
            for (const mvId of ['commit_baseline', 'baseline', 'optimize', 'measure', 'compare', 'check']) {
                standaloneNodeIds.add(mvId);
            }
        }
    }
    _emitReviewRatchet() {
        const spec = this._spec;
        const applied = this._applied;
        const standaloneNodeIds = this._standaloneNodeIds;
        const emit = this._emit.bind(this);
        const link = this._link.bind(this);
        if (!spec.reviewRatchet)
            return;
        applied.add('P19');
        const n = spec.reviewRatchet;
        for (let i = 1; i <= n; i++) {
            emit(`review_pass_${i}`, { label: `review pass ${i}`, shape: 'component' });
        }
        emit('review_merge', { label: 'review_merge', ratchet_count: String(n), shape: 'tripleoctagon' });
        emit('fix_review', { label: 'fix_review', shape: 'parallelogram' });
        for (let i = 1; i < n; i++) {
            link(`review_pass_${i}`, `review_pass_${i + 1}`);
        }
        link(`review_pass_${n}`, 'review_merge');
        link('review_merge', 'exit', { condition: 'outcome=success', label: 'pass' });
        link('review_merge', 'fix_review', { condition: 'outcome=fail', label: 'fail' });
        link('fix_review', 'review_pass_1');
        for (let ri = 1; ri <= n; ri++)
            standaloneNodeIds.add(`review_pass_${ri}`);
        standaloneNodeIds.add('review_merge');
        standaloneNodeIds.add('fix_review');
    }
    // eslint-disable-next-line complexity -- HT-1 reviewed: final graph assembly has isolated/convergence rewiring branches.
    _emitDot() {
        this._resetEmitState();
        this._initializeEmitContext();
        if (this._hasFanOut)
            this._emitFanOutTopology();
        else if (this._hasCompeting)
            this._emitCompetingTopology();
        else
            this._emitSequentialPhases();
        // P25: Catastrophic recovery loop (suppressed by convergence — iterate has its own retry)
        if (!this._hasFanOut && !this._hasCompeting && this._implPhases.length > 0 && !this._hasConvergence) {
            this._applied.add('P25');
            this._link('regression_check', 'setup_deps', { loop_restart: 'true' });
        }
        this._emitMicroverseLoop();
        this._emitReviewRatchet();
        // P0: Auto-inject commit_and_push for isolated workspace if missing
        if (this._spec.workspace === 'isolated') {
            const hasExplicitPush = [...this._nodeMap.keys()].some(isCommitPushPhaseId);
            if (!hasExplicitPush) {
                const slug = this._slug;
                this._emit('commit_and_push', {
                    label: 'commit_and_push',
                    shape: 'parallelogram',
                    timeout: DEFAULT_COMMIT_PUSH_TIMEOUT,
                    tool_command: `cd \${WORKING_DIR} && BRANCH="attractor/${slug}-$(echo $ATTRACTOR_RUN_ID | cut -c1-8)" && git checkout -B "$BRANCH" && git add -A && git -c user.name=attractor -c user.email=attractor@local commit -m "feat: ${slug} — attractor pipeline output" --allow-empty && git push origin "$BRANCH" --force 2>&1 && echo "Pushed branch: $BRANCH"`,
                });
                // Rewire: inject commit_and_push into the terminal chain
                if (this._hasConvergence) {
                    // v8: anchor on repro_verify -> done [condition="outcome=success"]
                    const rpToDone = this._edges.findIndex(e => e.includes('repro_verify -> done') && e.includes('outcome=success'));
                    if (rpToDone !== -1) {
                        const removedEdgeStr = this._edges[rpToDone];
                        this._edges.splice(rpToDone, 1);
                        const removedEdge = this._edgeList.findIndex(e => e.from === 'repro_verify' && e.to === 'done');
                        if (removedEdge !== -1)
                            this._edgeList.splice(removedEdge, 1);
                        this._seenEdges.delete(removedEdgeStr);
                    }
                    this._link('repro_verify', 'commit_and_push', { condition: 'outcome=success', label: 'pass' });
                    this._link('commit_and_push', 'done', { condition: 'outcome=success', label: 'pass' });
                }
                else {
                    // non-convergence: anchor on quality_review -> exit
                    const qrToExit = this._edges.findIndex(e => e.includes('quality_review -> exit'));
                    if (qrToExit !== -1) {
                        const removedEdgeStr = this._edges[qrToExit];
                        this._edges.splice(qrToExit, 1);
                        const removedEdge = this._edgeList.findIndex(e => e.from === 'quality_review' && e.to === 'exit');
                        if (removedEdge !== -1)
                            this._edgeList.splice(removedEdge, 1);
                        this._seenEdges.delete(removedEdgeStr);
                    }
                    this._link('quality_review', 'commit_and_push', { condition: 'outcome=success', label: 'pass' });
                    this._link('commit_and_push', 'exit');
                }
                this._applied.add('P0');
            }
        }
        // Emit exit terminal (suppressed in convergence mode — done is the sole Msquare terminal)
        if (!this._hasConvergence)
            this._emit('exit', { label: 'exit', shape: 'Msquare' });
        // P23: defense matrix comment block
        const guardPatterns = ['P0c', 'P6b', 'P10', 'P13', 'P14', 'P15', 'P17', 'P25'];
        this._defenseMatrix.guardrails = guardPatterns.filter(pg => this._applied.has(pg));
        this._applied.add('P23');
        const graphId = sanitizeId(this._slug) || 'pipeline';
        const lines = [
            `digraph "${graphId}" {`,
            `  graph [${fmtAttrs(this._graphAttrs)}]`,
            ...this._subgraphBlocks,
            `  /* DEFENSE MATRIX`,
            `   * competitive: ${this._defenseMatrix.competitive}`,
            `   * adversarial: ${this._defenseMatrix.adversarial}`,
            `   * specDriven: ${this._defenseMatrix.specDriven}`,
            `   * guardrails: ${this._defenseMatrix.guardrails.length > 0 ? this._defenseMatrix.guardrails.join(', ') : 'none'}`,
            `   * permissions: ${this._defenseMatrix.permissions.length > 0 ? this._defenseMatrix.permissions.join(', ') : 'none'}`,
            `   */`,
            ...this._nodes,
            ...this._edges,
            '}',
        ];
        return {
            dot: lines.join('\n'),
            patternsApplied: [...this._applied],
            defenseMatrix: this._defenseMatrix,
        };
    }
}
