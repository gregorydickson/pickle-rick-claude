import type { State } from '../types/index.js';
import { loadPickleSettingsBag, type TicketInfo } from './pickle-utils.js';

export type TicketComplexityTier = NonNullable<TicketInfo['complexity_tier']>;

export interface TicketTierBudget {
  tier: TicketComplexityTier;
  max_iterations: number;
  worker_timeout_seconds: number;
}

export const VALID_TICKET_COMPLEXITY_TIERS = ['trivial', 'small', 'medium', 'large'] as const;

export const TICKET_TIER_BUDGETS: Record<TicketComplexityTier, Omit<TicketTierBudget, 'tier'>> = {
  trivial: { max_iterations: 5, worker_timeout_seconds: 5 * 60 },
  small: { max_iterations: 10, worker_timeout_seconds: 10 * 60 },
  medium: { max_iterations: 30, worker_timeout_seconds: 60 * 60 },
  large: { max_iterations: 60, worker_timeout_seconds: 80 * 60 },
} as const;

export type LifecyclePhase =
  | 'research'
  | 'research_review'
  | 'plan'
  | 'plan_review'
  | 'implement'
  | 'conformance'
  | 'code_review'
  | 'simplify';

export const TIER_LIFECYCLE: Record<TicketComplexityTier, LifecyclePhase[]> = {
  trivial: ['implement', 'code_review'],
  small: ['plan', 'implement', 'code_review'],
  medium: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
  large: ['research', 'research_review', 'plan', 'plan_review', 'implement', 'conformance', 'code_review', 'simplify'],
} as const;

/** R-PIAP-A3: max changed LOC (additions + deletions) for each compact tier. Tunable. */
export const TIER_DIFF_ENVELOPE: Partial<Record<TicketComplexityTier, number>> = {
  trivial: 20,
  small: 80,
} as const;

export interface TierCapPartial {
  max_iterations?: number;
  worker_timeout_seconds?: number;
}

export type TierCapsConfig = Partial<Record<TicketComplexityTier, TierCapPartial>>;

export function normalizeTicketComplexityTier(value: unknown): TicketComplexityTier {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if ((VALID_TICKET_COMPLEXITY_TIERS as readonly string[]).includes(normalized)) {
      return normalized as TicketComplexityTier;
    }
  }
  return 'medium';
}

/**
 * Input shape for the deterministic tier classifier.
 * All fields are pure data — no I/O, no clock, no randomness needed.
 */
export interface TicketClassifierInfo {
  /** Number of distinct in-scope source files */
  fileCount: number;
  /** Number of acceptance criteria */
  acCount: number;
  /** LOC/diff estimate (0 when unknown) */
  locEstimate: number;
  /** Full ticket text for keyword scanning */
  text: string;
}

const CLASSIFIER_SMALLER_KEYWORDS = ['padding', 'typo', 'rename', 'delete', 'copy', 'label', 'color'] as const;
const CLASSIFIER_LARGER_KEYWORDS = ['integrate', 'migrate', 'schema', 'cross-cutting', 'refactor'] as const;
/**
 * R-TCVC: verify-command shapes that signal an expensive acceptance-criteria
 * verification cost (container/e2e suites, not a plain unit-test grep). Folded
 * into the SAME ±1 keyword delta as CLASSIFIER_LARGER_KEYWORDS — one list, no
 * separate classifier — so a ticket whose AC names one of these bumps one tier,
 * capped at 'large' by the existing delta clamp.
 *
 * Matched by `countKeywordHits`, i.e. the SAME word-boundary rule as every other
 * classifier list. A colon is interior to these literals, not at a boundary, so
 * `\btest:migration\b` matches `pnpm run test:migration` exactly as intended.
 */
export const CLASSIFIER_EXPENSIVE_VERIFY_KEYWORDS = [
  'test:migration',
  'docker',
  'compose',
  'e2e',
  'playwright',
  'run_expensive_tests',
  'test:integration',
] as const;

/**
 * AP-EXT-ITER2-01: the ONE keyword-matching rule for every classifier list.
 * Word-boundary anchored so a keyword only counts as its own word — `compose`
 * must not fire on `composes:`/`decomposed`, and `e2e` must not fire inside a
 * commit SHA like `1e2e14d8`. Keywords are regex-escaped; a colon or hyphen is
 * interior to the literal, so `\b` still anchors both ends correctly.
 */
function countKeywordHits(textLower: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(textLower)) hits++;
  }
  return hits;
}

function classifyDimension(val: number, thresholds: readonly [number, number, number]): number {
  if (val < thresholds[0]) return 0; // trivial
  if (val < thresholds[1]) return 1; // small
  if (val < thresholds[2]) return 2; // medium
  return 3; // large
}

/**
 * Pure, deterministic ticket complexity classifier.
 * No I/O, no clock, no randomness. Ties round UP to the larger tier.
 *
 * Tier thresholds:
 *   trivial: ≤1 file, ≤1 AC, ≤20 LOC
 *   small:    2 files, 2-3 ACs, 21-80 LOC
 *   medium:  3-4 files, 4-6 ACs, 81-250 LOC
 *   large:   ≥5 files, ≥7 ACs, ≥251 LOC
 *
 * Conservative tie-breaking: max() over dimension scores so any single
 * dimension that signals "large" produces at least "large" output.
 * Keyword delta (±1) is applied after the dimension max.
 */
export function classifyTicketTier(info: TicketClassifierInfo): TicketComplexityTier {
  const fileScore = classifyDimension(info.fileCount, [2, 3, 5]);
  const acScore = classifyDimension(info.acCount, [2, 4, 7]);
  const locScore = classifyDimension(info.locEstimate, [21, 81, 251]);

  // Conservative: ties round UP (take the maximum across dimensions)
  let score = Math.max(fileScore, acScore, locScore);

  // Keyword adjustment — clamped to [-1, 1] so keywords can't overwhelm signals
  const textLower = info.text.toLowerCase();
  const rawDelta =
    countKeywordHits(textLower, CLASSIFIER_LARGER_KEYWORDS) +
    countKeywordHits(textLower, CLASSIFIER_EXPENSIVE_VERIFY_KEYWORDS) -
    countKeywordHits(textLower, CLASSIFIER_SMALLER_KEYWORDS);
  const delta = Math.max(-1, Math.min(1, rawDelta));
  score = Math.max(0, Math.min(3, score + delta));

  return VALID_TICKET_COMPLEXITY_TIERS[score];
}

/**
 * R-PIAP-B1: tunable threshold for "UI-primary" diffs. A diff is UI-primary when
 * the share of changed lines that are visual STRICTLY EXCEEDS this value.
 * Default 0.60. Tunable via the optional `threshold` arg of
 * `classifyDiffVisualDominance`.
 */
export const VISUAL_DOMINANCE_THRESHOLD = 0.6;

/** Whole-file visual stylesheets: every changed line counts as visual. */
const VISUAL_FILE_EXT_RE = /\.(css|scss|sass|less)$/i;
/** JS/TS sources where visual lines are classified per-line. */
const SOURCE_FILE_EXT_RE = /\.(jsx|tsx|js|ts|mjs|cjs)$/i;
/** Opening of a styled-component template (`styled.button\`` / `styled(Foo)\``). */
const STYLED_TEMPLATE_OPENER_RE = /\bstyled(?:\.[A-Za-z]\w*|\([^)]*\))\s*`/;
/**
 * A single changed source line that is visual: JSX/TSX markup (`<Tag`, `</Tag`,
 * self-closing `/>`, fragment `<>`/`</>`), or a `className=` / `style=` / `class=`
 * edit.
 */
const VISUAL_SOURCE_LINE_RE = /<\/?[A-Za-z][\w.]*[\s/>]|\/>|<>|<\/>|\bclassName\s*=|\bstyle\s*=|\bclass\s*=/;

/**
 * Input shape for {@link classifyDiffVisualDominance}. One entry per changed file.
 * `changedLines` is the list of added/modified line texts in that file's diff —
 * its length is the per-file changed-line count, and its contents carry the
 * signal needed to classify visual lines inside mixed source files. Pure data:
 * no I/O is performed to obtain or interpret it.
 */
export interface DiffFileVisualStat {
  /** Repo-relative path; its extension drives whole-file visual classification. */
  path: string;
  /** Added/modified line texts for this file (one entry per changed line). */
  changedLines: string[];
}

export type DiffVisualStat = DiffFileVisualStat[];

/**
 * Count the visual changed lines in one file:
 *   - stylesheet extension  → all changed lines are visual;
 *   - non-source extension  → none are visual;
 *   - JS/TS source          → lines inside/opening a styled-component template,
 *                             or matching JSX/className/style markup, are visual.
 */
function countVisualChangedLines(filePath: string, changedLines: string[]): number {
  if (VISUAL_FILE_EXT_RE.test(filePath)) return changedLines.length;
  if (!SOURCE_FILE_EXT_RE.test(filePath)) return 0;

  let count = 0;
  let inStyledTemplate = false;
  for (const line of changedLines) {
    if (inStyledTemplate) {
      count++;
      if (line.includes('`')) inStyledTemplate = false;
      continue;
    }
    if (STYLED_TEMPLATE_OPENER_RE.test(line)) {
      count++;
      // Stay inside the template only if it does not also close on this line.
      if (!line.slice(line.indexOf('`') + 1).includes('`')) inStyledTemplate = true;
      continue;
    }
    if (VISUAL_SOURCE_LINE_RE.test(line)) count++;
  }
  return count;
}

/**
 * R-PIAP-B1: pure, deterministic predicate — is this diff UI-primary?
 *
 * Returns `true` when the share of changed lines that are visual strictly exceeds
 * `threshold` (default {@link VISUAL_DOMINANCE_THRESHOLD} = 0.60). "Visual" =
 * stylesheet files (`.css`/`.scss`/`.sass`/`.less`), styled-component template
 * blocks, and JSX/TSX markup or `className`/`style` edits (see
 * {@link countVisualChangedLines}).
 *
 * No I/O, no clock, no randomness. An empty diff (zero changed lines) returns
 * `false`. This is the RAW boolean only — the "err toward design-safe near the
 * threshold" policy is applied by the B2 caller, not here.
 */
export function classifyDiffVisualDominance(
  diffStat: DiffVisualStat,
  threshold: number = VISUAL_DOMINANCE_THRESHOLD,
): boolean {
  let totalChanged = 0;
  let totalVisual = 0;
  for (const file of diffStat) {
    const changed = file.changedLines.length;
    if (changed === 0) continue;
    totalChanged += changed;
    totalVisual += countVisualChangedLines(file.path, file.changedLines);
  }
  if (totalChanged === 0) return false;
  return totalVisual / totalChanged > threshold;
}

function readTierCapsBlock(block: unknown): TierCapsConfig {
  if (!block || typeof block !== 'object') return {};
  const result: TierCapsConfig = {};
  for (const tier of VALID_TICKET_COMPLEXITY_TIERS) {
    const entry = (block as Record<string, unknown>)[tier];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const partial: TierCapPartial = {};
    const maxIter = Number(e.max_iterations);
    if (Number.isFinite(maxIter) && Number.isInteger(maxIter) && maxIter > 0) {
      partial.max_iterations = maxIter;
    }
    const tmout = Number(e.worker_timeout_seconds);
    if (Number.isFinite(tmout) && Number.isInteger(tmout) && tmout > 0) {
      partial.worker_timeout_seconds = tmout;
    }
    if (partial.max_iterations !== undefined || partial.worker_timeout_seconds !== undefined) {
      result[tier] = partial;
    }
  }
  return result;
}

export function readPickleSettingsTierCaps(
  settings: Record<string, unknown> | null | undefined,
): TierCapsConfig {
  if (!settings) return {};
  return readTierCapsBlock((settings as { tier_caps?: unknown }).tier_caps);
}

export function readStateTierCapOverrides(
  state: State | null | undefined,
): TierCapsConfig {
  const flags = state?.flags;
  if (!flags || typeof flags !== 'object') return {};
  return readTierCapsBlock((flags as Record<string, unknown>).tier_cap_override);
}

/**
 * Canonical ticket-tier budget accessor. Resolution order, applied
 * independently per field (max_iterations, worker_timeout_seconds):
 *
 *   1. state.flags.tier_cap_override.<tier>.<field>
 *   2. pickle_settings.tier_caps.<tier>.<field>
 *   3. TICKET_TIER_BUDGETS[<tier>].<field>  (compiled-in default)
 *
 * Invalid (non-positive-integer) values fall through to the next tier of
 * precedence rather than throwing. Reader honors both pickle_settings v1
 * (schema_version absent) and v2 (schema_version === 2) — only the
 * `tier_caps` block is inspected, so older or newer settings files are safe.
 *
 * If `settings` is `undefined`, the on-disk pickle_settings.json is read via
 * `readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'))`.
 * Pass `null` to bypass disk I/O (compiled defaults only) — useful in tests.
 */
export function getTicketTierBudgetWithOverrides(
  state: State | null | undefined,
  tier: unknown,
  settings?: Record<string, unknown> | null,
): TicketTierBudget {
  const normalizedTier = normalizeTicketComplexityTier(tier);
  const defaults = TICKET_TIER_BUDGETS[normalizedTier];
  const settingsBag = settings === undefined ? loadPickleSettingsBag() : settings;
  const settingsCap = readPickleSettingsTierCaps(settingsBag)[normalizedTier] ?? {};
  const stateCap = readStateTierCapOverrides(state)[normalizedTier] ?? {};
  return {
    tier: normalizedTier,
    max_iterations: stateCap.max_iterations ?? settingsCap.max_iterations ?? defaults.max_iterations,
    worker_timeout_seconds: stateCap.worker_timeout_seconds ?? settingsCap.worker_timeout_seconds ?? defaults.worker_timeout_seconds,
  };
}

export function ticketTierBudget(tier: unknown): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, tier, null);
}

export function ticketInfoBudget(ticketInfo: Pick<TicketInfo, 'complexity_tier'> | null | undefined): TicketTierBudget {
  return getTicketTierBudgetWithOverrides(null, ticketInfo?.complexity_tier, null);
}
