import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runGate, runBaselineAwareGate, filterByScope, isCheckUnmeasured, resolveLexicalRepoRoot } from '../services/convergence-gate.js';
import { spawnGateRemediatorMain } from './spawn-gate-remediator.js';
import { readMicroverseState, readRecoverableJsonObject, recordCapUnmeasured, writeMicroverseState } from '../services/microverse-state.js';
import { logActivity } from '../services/activity-logger.js';
import { getExtensionRoot, isoCompactStamp, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import { buildWorkerInvocation, backendEnvOverrides, resolveBackend, } from '../services/backend-spawn.js';
const VALID_SKILLS = new Set(['szechuan', 'anatomy-park']);
const sm = new StateManager();
const DEFAULT_FINALIZE_GATE_SETTINGS = {
    szechuan_max_remediation_cycles: 3,
    anatomy_park_max_remediation_cycles: 5,
    citadel_max_remediation_cycles: 3,
    remediator_timeout_s: 600,
};
function positiveIntegerOrDefault(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizeFinalizeGateSettings(raw) {
    return {
        szechuan_max_remediation_cycles: positiveIntegerOrDefault(raw?.szechuan_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.szechuan_max_remediation_cycles),
        anatomy_park_max_remediation_cycles: positiveIntegerOrDefault(raw?.anatomy_park_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.anatomy_park_max_remediation_cycles),
        citadel_max_remediation_cycles: positiveIntegerOrDefault(raw?.citadel_max_remediation_cycles, DEFAULT_FINALIZE_GATE_SETTINGS.citadel_max_remediation_cycles),
        remediator_timeout_s: positiveIntegerOrDefault(raw?.remediator_timeout_s, DEFAULT_FINALIZE_GATE_SETTINGS.remediator_timeout_s),
    };
}
export function loadFinalizeGateSettings(extRoot) {
    try {
        const raw = readRecoverableJsonObject(path.join(extRoot, 'pickle_settings.json'));
        if (!raw)
            return DEFAULT_FINALIZE_GATE_SETTINGS;
        const cg = raw.convergence_gate;
        if (!cg || typeof cg !== 'object')
            return DEFAULT_FINALIZE_GATE_SETTINGS;
        return normalizeFinalizeGateSettings(cg);
    }
    catch {
        return DEFAULT_FINALIZE_GATE_SETTINGS;
    }
}
export function resolveFinalizeSettingsRoot() {
    const resolvedRoot = getExtensionRoot();
    const requestedRoot = process.env['EXTENSION_DIR'];
    if (requestedRoot && fs.existsSync(path.join(requestedRoot, 'pickle_settings.json'))) {
        return requestedRoot;
    }
    return resolvedRoot;
}
/**
 * AP-EXT-ITER272-01: `allowed_paths` is REPO-ROOT-relative — `resolve-scope.ts` anchors it at
 * `--show-toplevel` REGARDLESS of which `working_dir` invoked it (R-RSBI-2), and
 * `scope-resolver.ts:computeAllowedFromDiff` emits repo-relative paths. `workingDir` here is
 * `state.working_dir`, i.e. `process.cwd()` at setup — whatever directory the operator launched
 * from. Relativizing an absolute failure against THAT base put the two in different path spaces
 * whenever the launch dir sat below the git root: every failure missed the fence, `inScope`
 * emptied, and the cycle printed `all failures are out-of-scope` and EXITED 0 over a RED gate —
 * ran-to-completion reported as closed-within-scope. One shared base, via the same
 * `resolveLexicalRepoRoot` the sibling reader `selectWorkspaceTargetDirs` uses (AP-EXT-ITER34-01),
 * so reader and fence cannot disagree. Lexical, never `--show-toplevel`: toplevel is
 * realpath-resolved and would escape a lexical `failure.file` into `../../..`.
 */
function splitByScope(failures, allowedPaths, workingDir) {
    if (!allowedPaths || allowedPaths.length === 0) {
        return { inScope: failures, outOfScope: [] };
    }
    const inScope = [];
    const scopeCandidates = [];
    const scopeRoot = resolveLexicalRepoRoot(workingDir);
    for (const failure of failures) {
        if (/^<[^>]+>$/.test(failure.file) || !path.isAbsolute(failure.file)) {
            inScope.push(failure);
            continue;
        }
        scopeCandidates.push({
            failure,
            relFile: path.relative(scopeRoot, failure.file),
        });
    }
    const inScopeRel = new Set(filterByScope(scopeCandidates.map(({ relFile }) => relFile), { scope: 'full', allowedPaths }));
    for (const candidate of scopeCandidates) {
        if (inScopeRel.has(candidate.relFile)) {
            inScope.push(candidate.failure);
        }
    }
    const outOfScope = scopeCandidates
        .filter(candidate => !inScopeRel.has(candidate.relFile))
        .map(candidate => candidate.failure);
    return { inScope, outOfScope };
}
function defaultReadStateForWorkingDir(sessionRoot) {
    const statePath = path.join(sessionRoot, 'state.json');
    try {
        const state = sm.read(statePath);
        const workingDir = typeof state.working_dir === 'string' ? state.working_dir : process.cwd();
        const backend = resolveBackend(state);
        return { workingDir, backend };
    }
    catch {
        return null;
    }
}
function buildFinalizeRuntime(opts) {
    return {
        env: opts.env ?? process.env,
        out: opts.stdout ?? ((msg) => process.stdout.write(msg + '\n')),
        err: opts.stderr ?? ((msg) => process.stderr.write(msg + '\n')),
        doLogActivity: opts.logActivityFn ?? logActivity,
        iso: opts.isoFn ?? isoCompactStamp,
        mkdir: opts.mkdirSyncFn ?? ((p) => fs.mkdirSync(p, { recursive: true })),
        writeFile: opts.writeFileFn ?? ((p, data) => fs.writeFileSync(p, data, 'utf-8')),
        runGateFn: opts.runGateFn ?? runGate,
        writeMicroverseState: opts.writeMicroverseStateFn ?? writeMicroverseState,
        spawnBriefPrep: opts.spawnGateRemediatorMainFn ?? spawnGateRemediatorMain,
        spawnRemediator: opts.spawnRemediatorFn ?? defaultSpawnRemediator,
    };
}
function parseFinalizeArgs(opts, rt) {
    const [sessionRoot, skill] = opts.argv;
    if (!sessionRoot || !skill) {
        rt.err('Usage: finalize-gate <session-root> <skill>');
        rt.err('  skill: szechuan | anatomy-park');
        return null;
    }
    if (!VALID_SKILLS.has(skill)) {
        rt.err(`Invalid skill "${skill}". Must be: ${[...VALID_SKILLS].join(' | ')}`);
        return null;
    }
    return { sessionRoot, skill };
}
function loadFinalizeContext(opts, rt, sessionRoot, skill) {
    const mvState = (opts.readMicroverseStateFn ?? readMicroverseState)(sessionRoot);
    if (!mvState) {
        rt.err(`[finalize-gate] microverse.json not found in ${sessionRoot}`);
        return null;
    }
    const stateInfo = (opts.readStateForWorkingDirFn ?? defaultReadStateForWorkingDir)(sessionRoot);
    if (!stateInfo) {
        rt.err(`[finalize-gate] state.json not found or unreadable in ${sessionRoot}`);
        return null;
    }
    const settings = normalizeFinalizeGateSettings(opts.loadSettingsFn
        ? opts.loadSettingsFn()
        : loadFinalizeGateSettings(resolveFinalizeSettingsRoot()));
    const skillKey = skill.replace(/-/g, '_');
    const cap = skillKey === 'szechuan'
        ? settings.szechuan_max_remediation_cycles
        : settings.anatomy_park_max_remediation_cycles;
    return {
        sessionRoot,
        skill,
        skillKey,
        workingDir: stateInfo.workingDir,
        backend: stateInfo.backend,
        allowedPaths: mvState.allowed_paths,
        mvState,
        gateDir: path.join(sessionRoot, 'gate'),
        cap,
        remediatorTimeoutMs: settings.remediator_timeout_s * 1000,
    };
}
function writeOutOfScopeFailures(ctx, rt, cycle, outOfScope) {
    if (outOfScope.length === 0)
        return;
    const oosPath = path.join(ctx.gateDir, `out_of_scope_failures_${rt.iso()}.md`);
    const oosLines = outOfScope.map(f => `- \`${f.file}\` [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
    rt.writeFile(oosPath, `# Out-of-Scope Gate Failures\n\nCycle: ${cycle + 1}\nSkill: ${ctx.skill}\nTimestamp: ${new Date().toISOString()}\n\n${oosLines.join('\n')}\n`);
    rt.doLogActivity({
        event: 'gate_out_of_scope_failures_present',
        source: 'pickle',
        gate_payload: { count: outOfScope.length, cycle: cycle + 1 },
    });
    rt.out(`[finalize-gate] ${outOfScope.length} out-of-scope failure(s) — written to ${oosPath}`);
}
async function prepareRemediationBrief(ctx, rt, cycle, result) {
    const gateResultPath = path.join(ctx.gateDir, `gate_result_cycle_${rt.iso()}.json`);
    writeStateFile(gateResultPath, result);
    const briefLines = [];
    let briefCode;
    try {
        briefCode = await rt.spawnBriefPrep({
            argv: ['--gate-result', gateResultPath, '--session-root', ctx.sessionRoot, '--reason', 'strict'],
            stdout: (msg) => briefLines.push(msg),
            stderr: (msg) => rt.err(`[gate-remediator] ${msg}`),
        });
    }
    catch (e) {
        rt.err(`[finalize-gate] brief-prep threw on cycle ${cycle + 1}: ${safeErrorMessage(e)}`);
        return null;
    }
    if (briefCode !== 0) {
        rt.err(`[finalize-gate] brief-prep exited ${briefCode} on cycle ${cycle + 1} — skipping remediator`);
        return null;
    }
    const briefPathLine = briefLines.find(l => l.startsWith('BRIEF_PATH='));
    if (!briefPathLine) {
        rt.err(`[finalize-gate] no BRIEF_PATH from brief-prep on cycle ${cycle + 1}`);
        return null;
    }
    return briefPathLine.slice('BRIEF_PATH='.length);
}
function readBriefContent(briefPath, rt) {
    try {
        return fs.readFileSync(briefPath, 'utf-8');
    }
    catch (e) {
        rt.err(`[finalize-gate] cannot read brief at ${briefPath}: ${safeErrorMessage(e)}`);
        return null;
    }
}
function spawnStrictRemediator(ctx, rt, cycle, briefContent) {
    const invocation = buildWorkerInvocation(ctx.backend, {
        prompt: briefContent,
        addDirs: [ctx.workingDir],
    });
    rt.out(`[finalize-gate] spawning remediator (cycle ${cycle + 1})`);
    try {
        rt.spawnRemediator(invocation.cmd, invocation.args, {
            cwd: ctx.workingDir,
            timeout: ctx.remediatorTimeoutMs,
            env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
        });
    }
    catch (e) {
        rt.err(`[finalize-gate] remediator exited non-zero or timed out: ${safeErrorMessage(e)}`);
    }
}
/**
 * V3: a failure the remediator cannot act on — its check produced no measurement
 * (`isCheckUnmeasured`, e.g. a timeout) AND it names no editable path (the same non-absolute arm
 * `splitByScope` already forces in-scope). The path conjunct keeps a REAL failure of a check that
 * timed out in a sibling target dir remediable, since check status escalates across dirs.
 */
function isUnmeasuredFailure(result, failure) {
    return isCheckUnmeasured(result.check_status, failure.check) && !path.isAbsolute(failure.file);
}
/**
 * The gate never measured what it reports, so a remediation cycle would only rediscover that.
 * Disclose it — the checks ride `cap_unmeasured_checks`, which the pipeline reports as
 * `converged_with_unmeasured:<checks>` — and exit 0: an unmeasured check is a hole to report,
 * never a failed phase. Only cap exhaustion exits 2.
 */
function reportUnmeasuredGate(ctx, rt, cycle, checks, rows) {
    const reportPath = path.join(ctx.gateDir, `unmeasured_${rt.iso()}.md`);
    const lines = rows.map(f => `- [${f.check}] \`${f.file}\` ${f.ruleOrCode}: ${f.message.slice(0, 200)}`);
    rt.writeFile(reportPath, `# Gate Unmeasured\n\nCycle: ${cycle + 1}\nSkill: ${ctx.skill}\nChecks: ${checks.join(', ')}\nTimestamp: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`);
    rt.writeMicroverseState(ctx.sessionRoot, recordCapUnmeasured(ctx.mvState, checks));
    rt.err(`[finalize-gate] gate UNMEASURED on cycle ${cycle + 1} (${checks.join(', ')}) — no remediation cycle spent, disclosed, exit 0 (report: ${reportPath})`);
    return 0;
}
const FINALIZE_GATE_CHECKS = ['typecheck', 'lint', 'tests'];
/**
 * B-FINALGATE: only anatomy-park is judged against the session baseline. szechuan stays strict —
 * the baseline was captured by anatomy's run, not szechuan's. An empty path never reads, so the
 * shared helper chooses strict and never forwards it.
 */
function finalizeBaselinePath(ctx) {
    return ctx.skill === 'anatomy-park' ? path.join(ctx.gateDir, 'baseline.json') : '';
}
function logGateMode(ctx, rt, mode, baselinePath) {
    if (mode === 'baseline') {
        const capturedAt = readRecoverableJsonObject(baselinePath)?.captured_at;
        rt.err(`[finalize-gate] baseline mode (captured ${String(capturedAt)})`);
        return;
    }
    const why = baselinePath === '' ? `skill ${ctx.skill} is not baseline-scoped` : `no usable baseline at ${baselinePath}`;
    rt.err(`[finalize-gate] strict (${why})`);
}
async function runGateCycle(ctx, rt, cycle) {
    rt.out(`[finalize-gate] cycle ${cycle + 1}/${ctx.cap} — running gate`);
    const baselinePath = finalizeBaselinePath(ctx);
    // The helper owns the rule; this seam keeps the activity events and the full result the brief needs.
    const seen = {};
    const outcome = await runBaselineAwareGate({
        workingDir: ctx.workingDir,
        baselinePath,
        allowedPaths: ctx.allowedPaths,
        checks: [...FINALIZE_GATE_CHECKS],
        runGateFn: async (gateOpts) => (seen.result = await rt.runGateFn({
            ...gateOpts,
            onEvent: (event, data) => rt.doLogActivity({ event: event, source: 'pickle', gate_payload: data }),
        })),
    });
    logGateMode(ctx, rt, outcome.mode, baselinePath);
    const result = seen.result;
    if ('threw' in outcome || !result) {
        rt.err(`[finalize-gate] gate threw on cycle ${cycle + 1}: ${'threw' in outcome ? outcome.threw : 'no gate result'}`);
        return { code: 1 };
    }
    // The helper reads a timeout-only red with no check_status as green; a red status is never reported green.
    if (outcome.verdict === 'green' && result.status !== 'red') {
        rt.out(`[finalize-gate] gate green on cycle ${cycle + 1} — exit 0`);
        return { code: 0, result };
    }
    if (typeof outcome.verdict === 'object') {
        return { code: reportUnmeasuredGate(ctx, rt, cycle, outcome.verdict.unmeasured, outcome.failures), result };
    }
    return remediateRedGate(ctx, rt, cycle, result, outcome.failures);
}
async function remediateRedGate(ctx, rt, cycle, result, failures) {
    const { inScope, outOfScope } = splitByScope(failures, ctx.allowedPaths, ctx.workingDir);
    writeOutOfScopeFailures(ctx, rt, cycle, outOfScope);
    if (inScope.length === 0) {
        rt.out('[finalize-gate] all failures are out-of-scope — exit 0 (closed within scope)');
        return { code: 0, result };
    }
    const remediable = inScope.filter(f => !isUnmeasuredFailure(result, f));
    if (remediable.length === 0) {
        return { code: reportUnmeasuredGate(ctx, rt, cycle, [...new Set(inScope.map(f => f.check))], inScope), result };
    }
    const briefPath = await prepareRemediationBrief(ctx, rt, cycle, { ...result, failures: remediable });
    if (!briefPath)
        return { code: null, result };
    const briefContent = readBriefContent(briefPath, rt);
    if (!briefContent)
        return { code: null, result };
    spawnStrictRemediator(ctx, rt, cycle, briefContent);
    return { code: null, result };
}
function writeEscalation(ctx, rt, lastResult) {
    const escalationPath = path.join(ctx.gateDir, `escalation_${rt.iso()}.md`);
    const failures = lastResult?.failures ?? [];
    // R-FGNC-3: the escalation must show what the gate actually saw. With the
    // R-FGNC-1/2 classifier fix `failures` enumerates the REAL TS/lint errors
    // (no longer just `.npmrc` WARN noise) — group them by check so the operator
    // sees the true shape, and keep messages long enough to be actionable.
    const byCheck = new Map();
    for (const f of failures)
        byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    const checkSummary = [...byCheck.entries()].map(([c, n]) => `${c}: ${n}`).join(', ') || 'none';
    const failureLines = failures.map(f => `- \`${f.file}\`${f.line ? `:${f.line}` : ''} [${f.check}] ${f.ruleOrCode}: ${f.message.slice(0, 400)}`);
    rt.writeFile(escalationPath, [
        `# Gate Escalation: Cap Exhausted`,
        ``,
        `Skill: ${ctx.skill}`,
        `Cap: ${ctx.cap} cycles`,
        `Timestamp: ${new Date().toISOString()}`,
        `Remaining failures: ${failures.length} (${checkSummary})`,
        ``,
        `## Failures`,
        ``,
        ...(failureLines.length > 0
            ? failureLines
            : ['(none enumerated — inspect gate/ per-cycle result files for raw output)']),
        ``,
        `Manual remediation required. Check gate/ for per-cycle result files.`,
    ].join('\n'));
    return escalationPath;
}
export async function finalizeGateMain(opts) {
    const rt = buildFinalizeRuntime(opts);
    const args = parseFinalizeArgs(opts, rt);
    if (!args)
        return 1;
    if (rt.env.PICKLE_GATE_DISABLED === '1') {
        rt.doLogActivity({ event: 'gate_skipped', source: 'pickle', gate_payload: { reason: 'kill_switch' } });
        rt.out('[finalize-gate] PICKLE_GATE_DISABLED=1 — skipping post-runner gate');
        return 0;
    }
    if (opts.triggerExitReason) {
        rt.out(`[finalize-gate] triggered by exit_reason=${opts.triggerExitReason}`);
    }
    const ctx = loadFinalizeContext(opts, rt, args.sessionRoot, args.skill);
    if (!ctx)
        return 1;
    rt.mkdir(ctx.gateDir);
    const bundleEndGate = runAcPhaseGate({
        sessionDir: ctx.sessionRoot,
        evaluationPhase: 'bundle-end',
        cwd: ctx.workingDir,
        stdout: rt.out,
        stderr: rt.err,
    });
    if (bundleEndGate.status !== 'pass')
        return 2;
    let lastResult;
    for (let cycle = 0; cycle < ctx.cap; cycle++) {
        const cycleResult = await runGateCycle(ctx, rt, cycle);
        if (cycleResult.result)
            lastResult = cycleResult.result;
        if (cycleResult.code !== null)
            return cycleResult.code;
    }
    const escalationPath = writeEscalation(ctx, rt, lastResult);
    rt.err(`[finalize-gate] cap exhausted after ${ctx.cap} cycles — exit 2 (escalation: ${escalationPath})`);
    return 2;
}
function defaultSpawnRemediator(cmd, args, spawnOpts) {
    execFileSync(cmd, args, {
        cwd: spawnOpts.cwd,
        timeout: spawnOpts.timeout,
        stdio: 'pipe',
        env: spawnOpts.env,
    });
}
if (process.argv[1] && path.basename(process.argv[1]) === 'finalize-gate.js') {
    finalizeGateMain({ argv: process.argv.slice(2) })
        .then(code => process.exit(code))
        .catch(e => {
        process.stderr.write(`finalize-gate fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    });
}
