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
import { MUX_ITERATION_REASONS, type MuxIterationReason } from '../types/index.js';

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

export function isRealSession(session: string): boolean {
  return REAL_SESSION_RE.test(session);
}

/** One `wasted_iter` record, in the shape the two emitters write. */
export interface CorpusEvent {
  session: string;
  iteration?: number;
  runner?: string;
  action: string;
  pre_iter_sha?: string | null;
  post_iter_sha?: string | null;
  /**
   * The worker's lifecycle-artifact delta. Not emitted by either runtime path today, so
   * it is absent on every historical event; the fixture corpus carries it to exercise the
   * mux handoff arm. Absent means "unobserved", which the classifier treats
   * conservatively.
   */
  artifact_delta?: number | null;
}

export interface PredicateTally {
  classes: Record<MuxIterationReason, number>;
  iterations: number;
  wasted: number;
  /** Wasted iterations / total iterations, in `[0, 1]`. `0` for an empty population. */
  rate: number;
}

export interface ReplayResult {
  /** Corpus day-file range, e.g. `2026-08-05 .. 2026-08-06`. `null` if nothing loaded. */
  window: { first: string; last: string } | null;
  iterations: number;
  excludedFixtureEvents: number;
  excludedFixtureSessions: number;
  old: PredicateTally;
  new: PredicateTally;
}

/** Thrown when a tally's per-class counts do not sum to its iteration count. */
export class CorpusConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusConsistencyError';
  }
}

function emptyClasses(): Record<MuxIterationReason, number> {
  const classes = {} as Record<MuxIterationReason, number>;
  for (const reason of MUX_ITERATION_REASONS) classes[reason] = 0;
  return classes;
}

/**
 * The pre-`0aff6be2` predicate, reconstructed exactly:
 * `action === 'revert' || postIterSha === preIterSha`.
 *
 * The comparison is the bare `===`, deliberately NOT `classifyMuxIteration`'s null-safe
 * `moved` (`pre !== null && post !== null && pre !== post`). The old rule had no null
 * arm: one unreadable HEAD made `post === pre` FALSE, so it scored the iteration
 * committed. Borrowing the new rule's null handling makes this a THIRD predicate — the
 * one thing this module refuses to write — and it biases in the worst direction, charging
 * every half-null iteration to the OLD column as wasted and overstating the very drop the
 * replay exists to check. Both SHAs come from a failable `readHeadCommit`, read an
 * iteration apart, so a half-null is a live shape at both emitters, not a hypothetical.
 *
 * Reported in the shared vocabulary so the two columns are comparable, but the old rule
 * had no handoff or clean-pass arm — so `worker_handoff` and `clean_pass` are always 0
 * under it. That zero is the finding, not a gap in the replay: those iterations existed,
 * the old predicate simply could not see them and charged them to `no_progress`.
 */
export function classifyUnderOldPredicate(event: CorpusEvent): { wasted: boolean; reason: MuxIterationReason } {
  if (event.action === 'revert') return { wasted: true, reason: 'revert' };
  const pre = event.pre_iter_sha ?? null;
  const post = event.post_iter_sha ?? null;
  return post === pre
    ? { wasted: true, reason: 'no_progress' }
    : { wasted: false, reason: 'committed' };
}

/**
 * The post-fix predicate. Delegates to `classifyMuxIteration` — the runtime's own
 * classifier — rather than restating its rules.
 *
 * The recorded `reason` field (mux path, post-`7addedbf`) is deliberately not read: a
 * recount that trusted the label it is auditing would not be a recount.
 *
 * The one translation: microverse observes the designed worker handoff through its
 * pre-existing `'worker'` action label, while mux observes the same disposition through
 * the artifact delta. They are two observations of one disposition, so the label is fed
 * in as a positive delta. This is a projection of one runner's observable onto the
 * other's, not a second rule — every arm of the verdict still comes from
 * `classifyMuxIteration`.
 */
export function classifyUnderNewPredicate(event: CorpusEvent): { wasted: boolean; reason: MuxIterationReason } {
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
export function assertPopulationConsistent(
  classes: Record<MuxIterationReason, number>,
  iterations: number,
  label: string,
): void {
  const summed = MUX_ITERATION_REASONS.reduce((sum, reason) => sum + classes[reason], 0);
  if (summed !== iterations) {
    throw new CorpusConsistencyError(
      `${label} predicate: per-class counts sum to ${summed} but the corpus holds ${iterations} iterations — `
      + 'the replay is inconsistent; refusing to report a rate over a population that does not add up',
    );
  }
}

function tally(
  events: CorpusEvent[],
  classify: (event: CorpusEvent) => { wasted: boolean; reason: MuxIterationReason },
  label: string,
): PredicateTally {
  const classes = emptyClasses();
  let wasted = 0;
  for (const event of events) {
    const verdict = classify(event);
    classes[verdict.reason] += 1;
    if (verdict.wasted) wasted += 1;
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
export function replayCorpus(events: CorpusEvent[], window: ReplayResult['window'] = null): ReplayResult {
  const counted: CorpusEvent[] = [];
  const excludedSessions = new Set<string>();
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

export interface LoadedCorpus {
  events: CorpusEvent[];
  window: ReplayResult['window'];
}

/**
 * One NDJSON line to a `wasted_iter` event, or `null` for anything else. A torn line
 * yields `null` rather than throwing: the corpus is an append-only log that can be
 * truncated mid-write, and one bad line must not sink the recount. The cheap substring
 * test skips the `JSON.parse` on the ~99% of activity records that are not ours; the
 * parsed `event` field is the authority.
 */
function parseWastedIterLine(line: string): CorpusEvent | null {
  if (!line.includes('wasted_iter')) return null;
  try {
    const parsed = JSON.parse(line) as { event?: string } & CorpusEvent;
    return parsed.event === 'wasted_iter' ? parsed : null;
  } catch {
    return null;
  }
}

/** Read every `*.jsonl` day-file in `dir`, keeping only `wasted_iter` records. */
export function loadCorpusDir(dir: string, dayPrefix = ''): LoadedCorpus {
  const files = fs.readdirSync(dir)
    .filter(name => name.endsWith('.jsonl') && name.startsWith(dayPrefix))
    .sort();

  const events = files.flatMap(name => fs
    .readFileSync(path.join(dir, name), 'utf8')
    .split('\n')
    .map(parseWastedIterLine)
    .filter((event): event is CorpusEvent => event !== null));

  const days = files.map(name => name.replace(/\.jsonl$/, ''));
  return {
    events,
    window: days.length > 0 ? { first: days[0], last: days[days.length - 1] } : null,
  };
}

function formatRate(tallyResult: PredicateTally): string {
  const pct = tallyResult.iterations === 0 ? 0 : Math.round(tallyResult.rate * 1000) / 10;
  return `${tallyResult.wasted} / ${tallyResult.iterations} (${pct}%)`;
}

export function formatReplayReport(result: ReplayResult): string {
  const windowLine = result.window
    ? `${result.window.first} .. ${result.window.last}`
    : 'empty corpus';
  const rows = MUX_ITERATION_REASONS.map(
    reason => `| \`${reason}\` | ${result.old.classes[reason]} | ${result.new.classes[reason]} |`,
  );
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
  const readFlag = (flag: string): string | null => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
  };
  const corpusDir = readFlag('--corpus')
    ?? path.join(os.homedir(), '.local', 'share', 'pickle-rick', 'activity');
  const dayPrefix = readFlag('--day-prefix') ?? '';

  try {
    const { events, window } = loadCorpusDir(corpusDir, dayPrefix);
    process.stdout.write(formatReplayReport(replayCorpus(events, window)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`wasted-iter-replay failed: ${msg}\n`);
    process.exit(1);
  }
}
