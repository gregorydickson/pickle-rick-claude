// @tier: fast
// AC-N1: audit-ledger-probes.sh runs against temp-dir fixtures, never the real prds/MASTER_PLAN.md.
// AC-N4: N4-2 rests on the N1-3 case below — a row that survives the sweep with no probe reds this audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-ledger-probes.sh');

function runAudit(markdown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-probes-')));
  try {
    if (markdown !== null) {
      fs.mkdirSync(path.join(root, 'prds'), { recursive: true });
      fs.writeFileSync(path.join(root, 'prds', 'MASTER_PLAN.md'), markdown);
    }
    const result = spawnSync('bash', [AUDIT_SCRIPT], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, LEDGER_PROBES_ROOT_OVERRIDE: root },
    });
    assert.equal(result.error, undefined, `audit did not run: ${result.error}`);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const OPEN_WITH_PASSING_PROBE = `## OPEN BUG — sample defect (2026-01-01)

Some prose about the defect.

\`\`\`probe
true
\`\`\`
`;

const RESOLVED_NO_PROBE = `## ✅ RESOLVED (was OPEN BUG) — sample defect that got fixed

No probe needed — this row is closed.
`;

const DISPOSED_WITH_STRAY_FAILING_PROBE = `## ✅ DISPOSED BY MEASUREMENT (was TOP ITEM) — stray probe present

\`\`\`probe
false
\`\`\`
`;

test('N1-6 negative control: a well-formed ledger (open+probe, resolved+no-probe) passes', () => {
  const result = runAudit(`${OPEN_WITH_PASSING_PROBE}\n${RESOLVED_NO_PROBE}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 open, 1 probes confirmed OPEN/);
});

test('N1-6 mutation: re-marking a resolved fixture row OPEN BUG reds the audit', () => {
  const reopened = RESOLVED_NO_PROBE.replace('## ✅ RESOLVED (was OPEN BUG) —', '## OPEN BUG —');
  const result = runAudit(`${OPEN_WITH_PASSING_PROBE}\n${reopened}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /N1-3 no PROBE block: ## OPEN BUG — sample defect that got fixed/);
});

test('N1-6 mutation: deleting a probe from an open section reds the audit', () => {
  const stripped = OPEN_WITH_PASSING_PROBE.replace(/```probe[\s\S]*?```\n/, '');
  const result = runAudit(stripped);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /N1-3 no PROBE block: ## OPEN BUG — sample defect \(2026-01-01\)/);
});

test('N1-2: an open row whose probe reports FIXED reds the audit and names the row', () => {
  const nowFixed = OPEN_WITH_PASSING_PROBE.replace('true', 'false');
  const result = runAudit(nowFixed);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /N1-2 probe reports FIXED \(exit 1\) for a row marked open: ## OPEN BUG — sample defect \(2026-01-01\)/);
});

test('N1-3: an open row with no probe at all reds the audit', () => {
  const result = runAudit('## TOP ITEM — no probe ever written\n\nJust prose.\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /N1-3 no PROBE block: ## TOP ITEM — no probe ever written/);
});

test('N1-4 over-trigger control: a RESOLVED row with no probe never gets probed', () => {
  const result = runAudit(RESOLVED_NO_PROBE);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 open, 0 probes confirmed OPEN/);
  assert.equal(result.stderr, '');
});

test('N1-4 over-trigger control: a DISPOSED row with a stray FAILING probe still passes', () => {
  const result = runAudit(DISPOSED_WITH_STRAY_FAILING_PROBE);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 open, 0 probes confirmed OPEN/);
});

test('a missing MASTER_PLAN.md under the override root is a clean no-op', () => {
  const result = runAudit(null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to check/);
});

test('a heading-shaped line inside the probe fence does not split the section', () => {
  const withNestedHeading = `## OPEN BUG — fence-aware split sample

\`\`\`probe
cat <<'DOC'
## Acceptance Criteria
DOC
true
\`\`\`
`;
  const result = runAudit(withNestedHeading);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 open, 1 probes confirmed OPEN/);
});
