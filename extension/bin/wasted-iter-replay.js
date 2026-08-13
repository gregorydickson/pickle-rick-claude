/**
 * Ticket 129c61c4 (AC-A6): recount a fixed corpus of `wasted_iter` events under BOTH the
 * pre-fix and post-fix predicates, and report per-class counts plus a per-iteration
 * wasted rate for each.
 *
 * Why this exists: `0aff6be2` and `7addedbf` changed how an iteration is judged wasted,
 * and the bundle claimed the rate drops. A claimed rate change is an assertion until it
 * is recounted over one fixed population under both rules — and a predicate that
 * reproduces the old rate has fixed nothing.
 *
 * Two properties this module refuses to compromise on:
 *
 * 1. **It does not write a third predicate.** The NEW verdict comes from
 *    `classifyMuxIteration` (`mux-runner.ts`), the same function the runtime emits with.
 *    The OLD verdict is the deleted expression reconstructed verbatim
 *    (`git show 8de43871^:extension/src/bin/microverse-runner.ts`), which was
 *    character-identical on both runners.
 * 2. **It fails loudly on an inconsistent population.** Per-class counts that do not sum
 *    to the iteration count mean the replay is broken, not that the corpus is
 *    interesting. Reporting a rate over a population that does not add up would be worse
 *    than reporting nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyMuxIteration } from './mux-runner.js';
import { MUX_ITERATION_REASONS } from '../types/index.js';
/**
 * A real pipeline session directory is `<ISO date>-<8 hex>`. Everything else in the
 * activity corpus — `pickle-apxg3-3-gyQUnD`, `pickle-orsr6-selfred-X7btjb` — is a
 * `mkdtemp` name written by the test suite.
 *
 * This is not a nicety. Over August 2026 the corpus is 7449 `wasted_iter` events, of
 * which 7241 (97.2%) are synthetic. A recount that skips this filter measures the test
 * suite's fixtures, not the pipeline.
 */
export const REAL_SESSION_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
export function isRealSession(session) {
    return REAL_SESSION_RE.test(session);
}
/** Thrown when a tally's per-class counts do not sum to its iteration count. */
export class CorpusConsistencyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CorpusConsistencyError';
    }
}
function emptyClasses() {
    const classes = {};
    for (const reason of MUX_ITERATION_REASONS)
        classes[reason] = 0;
    return classes;
}
function movedHead(event) {
    const pre = event.pre_iter_sha ?? null;
    const post = event.post_iter_sha ?? null;
    return pre !== null && post !== null && pre !== post;
}
/**
 * The pre-`0aff6be2` predicate, reconstructed exactly:
 * `action === 'revert' || postIterSha === preIterSha`.
 *
 * Reported in the shared vocabulary so the two columns are comparable, but the old rule
 * had no handoff or clean-pass arm — so `worker_handoff` and `clean_pass` are always 0
 * under it. That zero is the finding, not a gap in the replay: those iterations existed,
 * the old predicate simply could not see them and charged them to `no_progress`.
 */
export function classifyUnderOldPredicate(event) {
    if (event.action === 'revert')
        return { wasted: true, reason: 'revert' };
    if (movedHead(event))
        return { wasted: false, reason: 'committed' };
    return { wasted: true, reason: 'no_progress' };
}
/**
 * The post-fix predicate. Delegates to `classifyMuxIteration` — the runtime's own
 * classifier — rather than restating its rules.
 *
 * The one translation: microverse observes the designed worker handoff through its
 * pre-existing `'worker'` action label, while mux observes the same disposition through
 * the artifact delta. They are two observations of one disposition, so the label is fed
 * in as a positive delta. This is a projection of one runner's observable onto the
 * other's, not a second rule — every arm of the verdict still comes from
 * `classifyMuxIteration`.
 */
export function classifyUnderNewPredicate(event) {
    const recordedDelta = event.artifact_delta ?? null;
    return classifyMuxIteration({
        action: event.action,
        preIterSha: event.pre_iter_sha ?? null,
        postIterSha: event.post_iter_sha ?? null,
        artifactDelta: event.action === 'worker' ? 1 : recordedDelta,
    });
}
/**
 * A corpus whose per-class counts do not sum to its iteration count is a failure of the
 * replay, not a finding. Reporting a rate over a population that does not add up would
 * produce a number nobody can act on, so this throws instead.
 */
export function assertPopulationConsistent(classes, iterations, label) {
    const summed = MUX_ITERATION_REASONS.reduce((sum, reason) => sum + classes[reason], 0);
    if (summed !== iterations) {
        throw new CorpusConsistencyError(`${label} predicate: per-class counts sum to ${summed} but the corpus holds ${iterations} iterations — `
            + 'the replay is inconsistent; refusing to report a rate over a population that does not add up');
    }
}
function tally(events, classify, label) {
    const classes = emptyClasses();
    let wasted = 0;
    for (const event of events) {
        const verdict = classify(event);
        classes[verdict.reason] += 1;
        if (verdict.wasted)
            wasted += 1;
    }
    const iterations = events.length;
    assertPopulationConsistent(classes, iterations, label);
    return { classes, iterations, wasted, rate: iterations === 0 ? 0 : wasted / iterations };
}
/**
 * Recount `events` under both predicates.
 *
 * The unit is the ITERATION: each runner emits exactly one `wasted_iter` per iteration,
 * so one event is one iteration. Counting raw activity records instead would weight
 * chatty iterations more heavily and produce a rate of nothing in particular.
 */
export function replayCorpus(events, window = null) {
    const counted = [];
    const excludedSessions = new Set();
    let excludedFixtureEvents = 0;
    for (const event of events) {
        if (isRealSession(String(event.session ?? ''))) {
            counted.push(event);
            continue;
        }
        excludedSessions.add(String(event.session ?? ''));
        excludedFixtureEvents += 1;
    }
    return {
        window,
        iterations: counted.length,
        excludedFixtureEvents,
        excludedFixtureSessions: excludedSessions.size,
        old: tally(counted, classifyUnderOldPredicate, 'old'),
        new: tally(counted, classifyUnderNewPredicate, 'new'),
    };
}
/**
 * Read every `*.jsonl` day-file in `dir`, keeping only `wasted_iter` records.
 * Malformed lines are skipped: the corpus is an append-only log that can be truncated
 * mid-write, and one torn line must not sink the recount.
 */
export function loadCorpusDir(dir, dayPrefix = '') {
    const files = fs.readdirSync(dir)
        .filter(name => name.endsWith('.jsonl') && name.startsWith(dayPrefix))
        .sort();
    const events = [];
    for (const name of files) {
        const raw = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.includes('wasted_iter'))
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (parsed.event === 'wasted_iter')
                events.push(parsed);
        }
    }
    const days = files.map(name => name.replace(/\.jsonl$/, ''));
    return {
        events,
        window: days.length > 0 ? { first: days[0], last: days[days.length - 1] } : null,
    };
}
function formatRate(tallyResult) {
    const pct = tallyResult.iterations === 0 ? 0 : Math.round(tallyResult.rate * 1000) / 10;
    return `${tallyResult.wasted} / ${tallyResult.iterations} (${pct}%)`;
}
export function formatReplayReport(result) {
    const windowLine = result.window
        ? `${result.window.first} .. ${result.window.last}`
        : 'empty corpus';
    const rows = MUX_ITERATION_REASONS.map(reason => `| \`${reason}\` | ${result.old.classes[reason]} | ${result.new.classes[reason]} |`);
    return [
        '# Wasted-iteration recount',
        '',
        `- **Window**: ${windowLine}`,
        `- **Iterations counted**: ${result.iterations}`,
        `- **Excluded fixture sessions**: ${result.excludedFixtureSessions} (${result.excludedFixtureEvents} events)`,
        '',
        '| Class | OLD predicate | NEW predicate |',
        '|-------|---------------|---------------|',
        ...rows,
        '',
        `- **Wasted (OLD)**: ${formatRate(result.old)}`,
        `- **Wasted (NEW)**: ${formatRate(result.new)}`,
        '',
        'The OLD predicate (`action === \'revert\' || postIterSha === preIterSha`) has no',
        'handoff or clean-pass arm, so those classes read 0 under it by construction — those',
        'iterations were charged to `no_progress`.',
        '',
    ].join('\n');
}
if (process.argv[1] && path.basename(process.argv[1]) === 'wasted-iter-replay.js') {
    const args = process.argv.slice(2);
    const readFlag = (flag) => {
        const at = args.indexOf(flag);
        return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
    };
    const corpusDir = readFlag('--corpus')
        ?? path.join(os.homedir(), '.local', 'share', 'pickle-rick', 'activity');
    const dayPrefix = readFlag('--day-prefix') ?? '';
    try {
        const { events, window } = loadCorpusDir(corpusDir, dayPrefix);
        process.stdout.write(formatReplayReport(replayCorpus(events, window)));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`wasted-iter-replay failed: ${msg}\n`);
        process.exit(1);
    }
}
