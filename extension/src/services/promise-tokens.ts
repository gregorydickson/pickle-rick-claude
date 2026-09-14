export const PROMISE_TOKENS = [
  'EPIC_COMPLETED',
  'TASK_COMPLETED',
  'ANALYSIS_DONE',
  'EXISTENCE_IS_PAIN',
  'THE_CITADEL_APPROVES',
  'WORKER_DONE',
  'PRD_COMPLETE',
  'TICKET_SELECTED',
] as const;

export type PromiseToken = typeof PROMISE_TOKENS[number];

/**
 * Promise tokens a per-ticket worker (send-to-morty.md / send-to-morty-review.md)
 * is FORBIDDEN from emitting. The worker's only valid completion signal is
 * `<promise>I AM DONE</promise>`. Every other token is orchestrator-scoped.
 *
 * Derived from PROMISE_TOKENS minus `WORKER_DONE` (the worker's own token), so
 * a newly added orchestrator token is forbidden to workers by default.
 *
 * Used by `scrubForbiddenWorkerTokens` to rewrite worker-emitted log content
 * before the manager (or any downstream consumer) reads it.
 */
export const FORBIDDEN_WORKER_TOKENS: readonly string[] = PROMISE_TOKENS.filter(
  (token) => token !== 'WORKER_DONE',
);

export interface ScrubResult {
  /** Log content with every forbidden `<promise>TOKEN</promise>` rewritten to `<promise>I AM DONE</promise>`. */
  scrubbed: string;
  /** Map of forbidden token name → number of replacements made. Empty when nothing was scrubbed. */
  replacements: Record<string, number>;
}

/**
 * Rewrite worker-emitted promise tokens that the worker has no authority to emit.
 *
 * A per-ticket worker MUST signal completion only via `<promise>I AM DONE</promise>`.
 * If a worker (especially a codex backend, which has been observed to confuse
 * tokens it sees nearby in source/prompt context) emits a forbidden token like
 * `<promise>EPIC_COMPLETED</promise>`, the manager reading the log can parrot it
 * forward, tripping mux-runner's pending-tickets fail-loud guard and killing the
 * pipeline mid-epic.
 *
 * Pure: no I/O, no globals, no side effects. Caller owns the read+write.
 *
 * Whitespace inside the tags is tolerated (matches `hasToken` semantics).
 */
export function scrubForbiddenWorkerTokens(content: string): ScrubResult {
  if (!content) return { scrubbed: content, replacements: {} };
  const replacements: Record<string, number> = {};
  let scrubbed = content;
  for (const token of FORBIDDEN_WORKER_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<promise>\\s*${escaped}\\s*</promise>`, 'g');
    let count = 0;
    scrubbed = scrubbed.replace(re, () => { count++; return '<promise>I AM DONE</promise>'; });
    if (count > 0) replacements[token] = count;
  }
  return { scrubbed, replacements };
}
