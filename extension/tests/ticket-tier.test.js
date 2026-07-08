// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyTicketTierBudget } from '../bin/mux-runner.js';
import {
  getTicketTierBudgetWithOverrides,
  parseTicketFrontmatter,
  readPickleSettingsTierCaps,
  readStateTierCapOverrides,
  ticketInfoBudget,
  ticketTierBudget,
} from '../services/pickle-utils.js';

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ticket-tier-')));
}

function writeTicket(sessionDir, id, tierLine) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${id}`,
    'title: Tier test',
    'status: Todo',
    'order: 1',
  ];
  if (tierLine !== null) frontmatter.push(tierLine);
  frontmatter.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), frontmatter.join('\n'));
}

function stateFor(ticketId) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 0,
    max_iterations: 99,
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: '',
  };
}

test('ticket-tier.budget-mapping: all tiers map to documented iteration and worker timeout budgets', () => {
  const cases = [
    ['trivial', 5, 5 * 60],
    ['small', 10, 10 * 60],
    ['medium', 30, 60 * 60],
    ['large', 60, 80 * 60],
  ];

  const root = tempRoot();
  try {
    for (const [tier, maxIterations, workerTimeoutSeconds] of cases) {
      const id = `ticket-${tier}`;
      writeTicket(root, id, `complexity_tier: ${tier}`);
      const ticketPath = path.join(root, id, `rick_ticket_${id}.md`);
      const parsed = parseTicketFrontmatter(ticketPath);
      assert.deepEqual(ticketInfoBudget(parsed), {
        tier,
        max_iterations: maxIterations,
        worker_timeout_seconds: workerTimeoutSeconds,
      });

      const state = stateFor(id);
      assert.deepEqual(applyTicketTierBudget(state, root), {
        tier,
        max_iterations: maxIterations,
        worker_timeout_seconds: workerTimeoutSeconds,
      });
      // R-CNAR-1 part 2: state.max_iterations is the GLOBAL manager-loop cap
      // (operator-set) and MUST be preserved across applyTicketTierBudget calls.
      // The per-ticket tier ceiling lives in state.current_ticket_max_iterations.
      assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
      assert.equal(state.worker_timeout_seconds, workerTimeoutSeconds);
      assert.equal(state.current_ticket_tier, tier);
      assert.equal(state.current_ticket_max_iterations, maxIterations);
      assert.equal(state.current_ticket_worker_timeout_seconds, workerTimeoutSeconds);
      assert.equal(state.current_ticket_budget_start_iteration, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ticket-tier.default: missing and invalid tiers default to medium budget', () => {
  const expected = {
    tier: 'medium',
    max_iterations: 30,
    worker_timeout_seconds: 60 * 60,
  };

  assert.deepEqual(ticketTierBudget(undefined), expected);
  assert.deepEqual(ticketTierBudget('bogus'), expected);

  const root = tempRoot();
  try {
    for (const [id, tierLine] of [['missing', null], ['invalid', 'complexity_tier: bogus']]) {
      writeTicket(root, id, tierLine);
      const parsed = parseTicketFrontmatter(path.join(root, id, `rick_ticket_${id}.md`));
      assert.deepEqual(ticketInfoBudget(parsed), expected);

      const state = stateFor(id);
      assert.deepEqual(applyTicketTierBudget(state, root), expected);
      // R-CNAR-1 part 2: global max_iterations preserved; per-ticket cache holds tier value.
      assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
      assert.equal(state.current_ticket_max_iterations, expected.max_iterations);
      assert.equal(state.worker_timeout_seconds, expected.worker_timeout_seconds);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ticket-tier.budget-mapping: cached tier is stable when frontmatter changes mid-execution', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'complexity_tier: large');
    const state = stateFor('t1');
    assert.equal(applyTicketTierBudget(state, root).tier, 'large');

    writeTicket(root, 't1', 'complexity_tier: trivial');
    const budget = applyTicketTierBudget(state, root);
    assert.deepEqual(budget, {
      tier: 'large',
      max_iterations: 60,
      worker_timeout_seconds: 80 * 60,
    });
    // R-CNAR-1 part 2: global max_iterations preserved (still 99 from stateFor);
    // per-ticket cache holds the cached large-tier value.
    assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
    assert.equal(state.current_ticket_max_iterations, 60);
    assert.equal(state.worker_timeout_seconds, 80 * 60);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// R-CNAR-1: ticket-tier-budget override precedence (state.flags >
// pickle_settings.tier_caps > TICKET_TIER_BUDGETS hardcoded defaults).
// ──────────────────────────────────────────────────────────────────────────

test('ticket-tier-budget overrides: defaults applied when no settings or flags', () => {
  const budget = getTicketTierBudgetWithOverrides(null, 'medium', null);
  assert.deepEqual(budget, { tier: 'medium', max_iterations: 30, worker_timeout_seconds: 60 * 60 });
});

test('ticket-tier-budget overrides: pickle_settings.tier_caps fully overrides field-level', () => {
  const settings = {
    schema_version: 2,
    tier_caps: {
      medium: { max_iterations: 99, worker_timeout_seconds: 1234 },
    },
  };
  const budget = getTicketTierBudgetWithOverrides(null, 'medium', settings);
  assert.deepEqual(budget, { tier: 'medium', max_iterations: 99, worker_timeout_seconds: 1234 });
});

test('ticket-tier-budget overrides: pickle_settings.tier_caps partial leaves the other field at default', () => {
  const settings = {
    schema_version: 2,
    tier_caps: { large: { max_iterations: 75 } },
  };
  const budget = getTicketTierBudgetWithOverrides(null, 'large', settings);
  assert.deepEqual(budget, { tier: 'large', max_iterations: 75, worker_timeout_seconds: 80 * 60 });
});

test('ticket-tier-budget overrides: state.flags.tier_cap_override beats pickle_settings.tier_caps', () => {
  const settings = {
    schema_version: 2,
    tier_caps: {
      small: { max_iterations: 22, worker_timeout_seconds: 2222 },
    },
  };
  const state = {
    flags: {
      tier_cap_override: {
        small: { max_iterations: 333, worker_timeout_seconds: 3333 },
      },
    },
  };
  const budget = getTicketTierBudgetWithOverrides(state, 'small', settings);
  assert.deepEqual(budget, { tier: 'small', max_iterations: 333, worker_timeout_seconds: 3333 });
});

test('ticket-tier-budget overrides: state.flags partial mixes with settings + defaults independently', () => {
  // state.flags overrides only worker_timeout_seconds for trivial; settings
  // overrides only max_iterations for trivial; both must win for their field.
  const settings = {
    schema_version: 2,
    tier_caps: { trivial: { max_iterations: 7 } },
  };
  const state = {
    flags: {
      tier_cap_override: { trivial: { worker_timeout_seconds: 11 } },
    },
  };
  const budget = getTicketTierBudgetWithOverrides(state, 'trivial', settings);
  assert.deepEqual(budget, { tier: 'trivial', max_iterations: 7, worker_timeout_seconds: 11 });
});

test('ticket-tier-budget overrides: invalid (zero/negative/NaN/non-int) values fall through', () => {
  const settings = {
    tier_caps: {
      medium: { max_iterations: 0, worker_timeout_seconds: -1 }, // both invalid
      large: { max_iterations: 'oops', worker_timeout_seconds: 1.5 }, // both invalid
    },
  };
  const state = {
    flags: {
      tier_cap_override: {
        medium: { max_iterations: NaN, worker_timeout_seconds: Infinity }, // both invalid
      },
    },
  };
  const medium = getTicketTierBudgetWithOverrides(state, 'medium', settings);
  assert.deepEqual(medium, { tier: 'medium', max_iterations: 30, worker_timeout_seconds: 60 * 60 });
  const large = getTicketTierBudgetWithOverrides(state, 'large', settings);
  assert.deepEqual(large, { tier: 'large', max_iterations: 60, worker_timeout_seconds: 80 * 60 });
});

test('ticket-tier-budget overrides: schema_version v1 (absent) and v2 are both honored', () => {
  // v1 — settings file with no schema_version key.
  const v1 = {
    tier_caps: { trivial: { max_iterations: 8 } },
  };
  // v2 — settings file with schema_version === 2.
  const v2 = {
    schema_version: 2,
    tier_caps: { trivial: { max_iterations: 8 } },
  };
  const expected = { tier: 'trivial', max_iterations: 8, worker_timeout_seconds: 5 * 60 };
  assert.deepEqual(getTicketTierBudgetWithOverrides(null, 'trivial', v1), expected);
  assert.deepEqual(getTicketTierBudgetWithOverrides(null, 'trivial', v2), expected);
});

test('ticket-tier-budget overrides: readPickleSettingsTierCaps and readStateTierCapOverrides parse partials', () => {
  const settings = {
    tier_caps: {
      trivial: { max_iterations: 1 },
      medium: { worker_timeout_seconds: 222 },
      bogus: { max_iterations: 9 }, // not a valid tier — ignored
      large: { max_iterations: 'x', worker_timeout_seconds: 0 }, // both invalid — entry dropped
    },
  };
  assert.deepEqual(readPickleSettingsTierCaps(settings), {
    trivial: { max_iterations: 1 },
    medium: { worker_timeout_seconds: 222 },
  });

  const state = {
    flags: {
      tier_cap_override: {
        small: { max_iterations: 4, worker_timeout_seconds: 44 },
      },
    },
  };
  assert.deepEqual(readStateTierCapOverrides(state), {
    small: { max_iterations: 4, worker_timeout_seconds: 44 },
  });

  assert.deepEqual(readPickleSettingsTierCaps(null), {});
  assert.deepEqual(readPickleSettingsTierCaps({}), {});
  assert.deepEqual(readStateTierCapOverrides(null), {});
  assert.deepEqual(readStateTierCapOverrides({ flags: {} }), {});
});
