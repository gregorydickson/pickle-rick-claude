#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
CLAUDE_PATH="${CLAUDE_PATH_OVERRIDE:-$EXTENSION_ROOT/CLAUDE.md}"
SOURCE_CLAUDE_PATH="$EXTENSION_ROOT/src/bin/CLAUDE.md"
CLOSER_AUDIT_REPO="${CLOSER_AUDIT_REPO_OVERRIDE:-$REPO_ROOT}"

if [ ! -f "$CLAUDE_PATH" ]; then
  echo "[skipped: extension/CLAUDE.md not found]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

audit_exit_code=0

fail() {
  echo "$1" >&2
  audit_exit_code=1
}

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-CNAR-1 part 2 cap split)'));

if (!entry) {
  process.stderr.write('R-CNAR-7 trap-door entry not found\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-CNAR-7 trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
NODE
then
  audit_exit_code=1
fi

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(dirty-tree guard)'));

if (!entry) {
  process.stderr.write('R-PDT-4 dirty-tree guard trap-door entry not found\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-PDT-4 dirty-tree guard trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
NODE
then
  audit_exit_code=1
fi

# Parse ENFORCE: references and check reachability via node so we get the
# same regex as trap-door-conformance.test.js (avoids BSD/GNU grep -P gap).
if ! node - "$CLAUDE_PATH" "$EXTENSION_ROOT" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, claudePath, extensionRoot, repoRoot] = process.argv;

const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');

const VALID_TIERS = new Set(['fast', 'integration', 'expensive', 'contract']);

// Collect all ENFORCE: test file references using the same regex as
// extractEnforceTestFiles() in trap-door-conformance.test.js.
const enforceFiles = new Map(); // relative path -> line number

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.includes('ENFORCE:')) continue;

  // Gather entry text (current line + continuation until next entry/section)
  let entryText = line;
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('## ')) {
    entryText += '\n' + lines[j];
    j++;
  }

  const matches = entryText.matchAll(/\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b/g);
  for (const m of matches) {
    if (!enforceFiles.has(m[1])) {
      enforceFiles.set(m[1], i + 1);
    }
  }
}

let failures = 0;

for (const [rel, lineNum] of enforceFiles) {
  // Resolve: 'extension/tests/...' → repo root; 'tests/...' → extension root
  const absPath = rel.startsWith('extension/')
    ? path.join(repoRoot, rel)
    : path.join(extensionRoot, rel);

  if (!fs.existsSync(absPath)) {
    process.stderr.write(`ENFORCE: line ${lineNum}: missing file: ${rel}\n`);
    failures++;
    continue;
  }

  // Read first meaningful line (skip shebang and blank lines)
  const fileContent = fs.readFileSync(absPath, 'utf8');
  const firstMeaningful = fileContent.split(/\r?\n/).find(
    l => !l.startsWith('#!') && l.trim() !== ''
  ) ?? '';

  const tierMatch = firstMeaningful.match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
  if (!tierMatch || !VALID_TIERS.has(tierMatch[1])) {
    process.stderr.write(
      `ENFORCE: line ${lineNum}: no valid @tier annotation in ${rel} (first line: ${firstMeaningful.substring(0, 80)})\n`
    );
    failures++;
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} ENFORCE reference(s) unreachable\n`);
  process.exit(1);
}

console.log(`audit-trap-door-enforcement: ${enforceFiles.size} ENFORCE reference(s) verified`);
NODE
then
  audit_exit_code=1
fi

if ! node - "$SOURCE_CLAUDE_PATH" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, sourceClaudePath, repoRoot] = process.argv;

if (!fs.existsSync(sourceClaudePath)) {
  process.stderr.write(`R-MMTR-5 source trap-door file not found: ${sourceClaudePath}\n`);
  process.exit(1);
}

const text = fs.readFileSync(sourceClaudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-MMTR-3 claude max-turns relaunch)'));

if (!entry) {
  process.stderr.write('R-MMTR-5 trap-door entry not found in extension/src/bin/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'BREAKS', 'ENFORCE'];
for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-MMTR-5 trap-door entry is missing populated ${label} content\n`);
    process.exit(1);
  }
}

const requiredSnippets = [
  'mux-runner.ts:3696-3730',
  'evaluateManagerRelaunch',
  'Defaults.CLAUDE_MANAGER_RELAUNCH_CAP',
  'CLAUDE_MANAGER_RELAUNCH_CAP=20',
];

for (const snippet of requiredSnippets) {
  if (!entry.includes(snippet)) {
    process.stderr.write(`R-MMTR-5 trap-door entry missing required snippet: ${snippet}\n`);
    process.exit(1);
  }
}

const matches = [...entry.matchAll(/\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b/g)];
const expected = [
  'extension/tests/mux-runner-claude-max-turns-relaunch.test.js',
  'extension/tests/manager-relaunch.test.js',
];

for (const rel of expected) {
  if (!matches.some((match) => match[1] === rel)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE is missing expected test: ${rel}\n`);
    process.exit(1);
  }

  const absPath = path.join(repoRoot, rel);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE target missing: ${rel}\n`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(absPath, 'utf8');
  const firstMeaningful = fileContent.split(/\r?\n/).find(
    (line) => !line.startsWith('#!') && line.trim() !== ''
  ) ?? '';

  if (!/^\/\/\s*@tier:\s*(fast|integration|expensive|contract)\s*$/.test(firstMeaningful)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE target missing valid @tier: ${rel}\n`);
    process.exit(1);
  }
}

console.log('audit-trap-door-enforcement: R-MMTR-5 source trap-door verified');
NODE
then
  audit_exit_code=1
fi

if ! bash "$SCRIPT_DIR/audit-phantom-done-call-sites.sh"; then
  audit_exit_code=1
fi

if rg -n -e "npm (ci|install)" \
  "$EXTENSION_ROOT/src/bin/spawn-morty.ts" \
  "$EXTENSION_ROOT/src/bin/mux-runner.ts" >/dev/null; then
  fail 'worker boot paths must reuse extension/node_modules; found npm ci/install in spawn-morty.ts or mux-runner.ts'
fi

# T-HARDEN-PROBE: verify --judge-probe requires PICKLE_JUDGE_PROBE_ALLOWED=1 guard
if ! node - "$EXTENSION_ROOT/src/bin/microverse-runner.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Verify --judge-probe flag check exists in the CLI entry block
const probeIdx = text.indexOf("'--judge-probe'");
if (probeIdx < 0) {
  process.stderr.write('T-HARDEN-PROBE: --judge-probe flag not found in microverse-runner.ts\n');
  process.exit(1);
}

// Verify PICKLE_JUDGE_PROBE_ALLOWED guard appears AFTER the --judge-probe check
// (inside the same if-block) within 300 chars
const afterProbe = text.slice(probeIdx);
const guardIdx = afterProbe.indexOf('PICKLE_JUDGE_PROBE_ALLOWED');
if (guardIdx < 0 || guardIdx > 300) {
  process.stderr.write(
    'T-HARDEN-PROBE: PICKLE_JUDGE_PROBE_ALLOWED guard must appear within 300 chars after --judge-probe check\n'
  );
  process.exit(1);
}

console.log('T-HARDEN-PROBE: --judge-probe env guard verified in microverse-runner.ts');
NODE
then
  audit_exit_code=1
fi

# R-CLOSER-ADJACENCY-AUDIT: closer commits must include the 6-step adjacency-audit section
if ! node - "$CLOSER_AUDIT_REPO" <<'NODE'
const { execFileSync } = require('child_process');

const [,, repoRoot] = process.argv;

// Find the commit that introduced R-CLOSER-ADJACENCY-AUDIT to citadel.md.
// Only check closer commits after that point — the template didn't exist before.
let baselineSha = '';
try {
  const pickaxeOut = execFileSync(
    'git',
    ['log', '--oneline', '-S', 'R-CLOSER-ADJACENCY-AUDIT', '--', '.claude/commands/citadel.md'],
    { encoding: 'utf8', cwd: repoRoot, timeout: 10000 }
  ).trim();
  const lines = pickaxeOut.split('\n').filter(Boolean);
  if (lines.length > 0) {
    // Last line is the oldest commit that introduced the template
    baselineSha = lines[lines.length - 1].trim().split(/\s+/)[0];
  }
} catch (_) {
  // Can't determine baseline; check all commits
}

const range = baselineSha ? `${baselineSha}..HEAD` : 'HEAD';
let logOutput;
try {
  logOutput = execFileSync(
    'git',
    ['log', '--format=%H%x00%s%x00%b%x02', range],
    // Full commit BODIES accumulate here, so this output grows without bound as the
    // branch advances; Node's 1MB default maxBuffer breached at 96b08eba (1049881B)
    // and turned the whole audit into `spawnSync git ENOBUFS`.
    { encoding: 'utf8', cwd: repoRoot, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`R-CLOSER-ADJACENCY-AUDIT: git log failed: ${msg}\n`);
  process.exit(1);
}

const commits = logOutput.split('\x02').map(s => s.trim()).filter(Boolean);

const closerSubjectRe = /^(fix|chore|docs)\([0-9a-f]{6,12}\): R-.*[Cc]loser/;
// Detect by body only when the section header itself is present — prevents false
// positives on implementation commits that describe the audit protocol in prose.
const adjacencyBodyRe = /^## Adjacency audit \(R-CLOSER-ADJACENCY-AUDIT\)/m;
const sectionHeaderRe = /^## Adjacency audit \(R-CLOSER-ADJACENCY-AUDIT\)/m;
const itemRe = /^(?:\d+\.|-) .+: (?:Y|N|N\/A)\b/gm;

const failures = [];
let closerCount = 0;

for (const commitText of commits) {
  const nul1 = commitText.indexOf('\x00');
  const nul2 = nul1 >= 0 ? commitText.indexOf('\x00', nul1 + 1) : -1;
  if (nul1 < 0 || nul2 < 0) continue;

  const hash = commitText.slice(0, nul1).trim();
  const subject = commitText.slice(nul1 + 1, nul2).trim();
  const body = commitText.slice(nul2 + 1);

  const isCloser = closerSubjectRe.test(subject) || adjacencyBodyRe.test(body);
  if (!isCloser) continue;
  closerCount++;

  if (!sectionHeaderRe.test(body)) {
    failures.push(
      `${hash.slice(0, 12)} "${subject}": missing "## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)" section`
    );
    continue;
  }

  const items = body.match(itemRe) || [];
  if (items.length < 6) {
    failures.push(
      `${hash.slice(0, 12)} "${subject}": adjacency-audit section has ${items.length}/6 Y/N items (need ≥6)`
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `R-CLOSER-ADJACENCY-AUDIT: ${failures.length} closer commit(s) missing adjacency-audit section:\n`
  );
  for (const f of failures) {
    process.stderr.write(`  ${f}\n`);
  }
  process.exit(1);
}

console.log(
  `audit-trap-door-enforcement: R-CLOSER-ADJACENCY-AUDIT: ${closerCount} closer commit(s) checked, all pass`
);
NODE
then
  audit_exit_code=1
fi

# R-AFCC-STAGE: non-repo workingDir containment — verify canonical literals present in ticket-completion-evidence.ts
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Canonical literal 1: R-AFCC-STAGE annotation comment
if (!text.includes('// R-AFCC-STAGE:')) {
  process.stderr.write('R-AFCC-STAGE: canonical annotation "// R-AFCC-STAGE:" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

// Canonical literal 2: required-throw guard in persistEvidence
if (!text.includes("if (opts.stage === 'required') throw")) {
  process.stderr.write('R-AFCC-STAGE: canonical literal "if (opts.stage === \'required\') throw" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-STAGE literals verified');
NODE
then
  audit_exit_code=1
fi

# R-AFCC-WRITE-OBSERVABILITY: write-vs-stage telemetry split — verify staged?: boolean in PersistResult
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Canonical literal: staged?: boolean field in PersistResult
if (!text.includes('staged?: boolean')) {
  process.stderr.write('R-AFCC-WRITE-OBSERVABILITY: canonical literal "staged?: boolean" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-WRITE-OBSERVABILITY literal verified');
NODE
then
  audit_exit_code=1
fi

# R-AFCC-CALLER-ENUMERATION: oracle callsite audit — verify exactly 2 caller files import ticket-completion-evidence
if ! node - "$EXTENSION_ROOT/src" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [,, srcDir] = process.argv;

let grepOutput;
try {
  grepOutput = execFileSync(
    'grep',
    ['-rln', 'ticket-completion-evidence', srcDir, '--include=*.ts'],
    { encoding: 'utf8', timeout: 10000 }
  );
} catch (e) {
  // grep exits 1 when no matches — treat as 0 files
  grepOutput = (e.stdout) || '';
}

const files = grepOutput.trim().split('\n').filter(Boolean)
  .filter(f => !f.endsWith('ticket-completion-evidence.ts'));

const EXPECTED_CALLERS = [
  'mux-runner.ts',
  'auto-fill-completion-commit.ts',
];

const basenames = files.map(f => path.basename(f));
const missing = EXPECTED_CALLERS.filter(e => !basenames.includes(e));
const unexpected = basenames.filter(b => !EXPECTED_CALLERS.includes(b));

let failures = 0;

if (files.length !== EXPECTED_CALLERS.length) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: expected exactly ${EXPECTED_CALLERS.length} caller files, found ${files.length}\n`
  );
  failures++;
}

if (missing.length > 0) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: expected caller(s) missing: ${missing.join(', ')}\n`
  );
  failures++;
}

if (unexpected.length > 0) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: unexpected new caller(s) found — update pin count: ${unexpected.join(', ')}\n`
  );
  failures++;
}

if (failures > 0) {
  process.exit(1);
}

console.log(`audit-trap-door-enforcement: R-AFCC-CALLER-ENUMERATION verified (${files.length} callers: ${basenames.join(', ')})`);
NODE
then
  audit_exit_code=1
fi

# B-1SEAM WS-1: completion-predicate single-seam pins (mirrors
# extension/tests/completion-predicate-single-seam.test.js; importer-set pin 3
# is the R-AFCC-CALLER-ENUMERATION block above).
if ! node - "$EXTENSION_ROOT/src" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, srcDir] = process.argv;
let failures = 0;

const ORACLE_BASENAME = 'ticket-completion-evidence.ts';
// Enumerated buildCompletionCtx consumers in mux-runner.ts: collectTwinEvidence,
// validateAutoTicketCompletion, isTicketOracleCommitted,
// guardCompletionCommitBeforeDone, attributeBoundaryHeadMoved, defaultDoneGuard.
const MUX_PREDICATE_CALLSITES = 6;
// A callsite passes an argument; the guard refusal string's zero-arg prose form
// `readEvidence().kind` is spared by the [^)\s] after the paren.
const READ_EVIDENCE_CALLSITE_RE = /\breadEvidence\(\s*[^)\s]/;

function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) result.push(full);
  }
  return result;
}

function nonCommentText(content) {
  return content.split('\n').filter((line) => {
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

function extractTopLevelFunction(content, signature, label) {
  const start = content.indexOf(signature);
  if (start === -1) {
    process.stderr.write(`B-1SEAM: ${label}: ${signature} not found in mux-runner.ts\n`);
    failures++;
    return '';
  }
  // \n}\n terminator: bare \n} would truncate at a multi-line params type's column-0 }).
  const end = content.indexOf('\n}\n', start);
  if (end === -1) {
    process.stderr.write(`B-1SEAM: ${label}: no column-0 closing brace after ${signature}\n`);
    failures++;
    return '';
  }
  return content.slice(start, end + 3);
}

// Pin 1: zero readEvidence(<arg>) callsites outside the oracle.
for (const filePath of walkTs(srcDir)) {
  if (path.basename(filePath) === ORACLE_BASENAME) continue;
  if (READ_EVIDENCE_CALLSITE_RE.test(nonCommentText(fs.readFileSync(filePath, 'utf8')))) {
    process.stderr.write(`B-1SEAM: readEvidence( callsite outside ${ORACLE_BASENAME}: ${path.relative(srcDir, filePath)}\n`);
    failures++;
  }
}

// Pin 2: exact evaluateCompletionEvidence( callsite counts.
const muxContent = fs.readFileSync(path.join(srcDir, 'bin', 'mux-runner.ts'), 'utf8');
const autoFillContent = fs.readFileSync(path.join(srcDir, 'bin', 'auto-fill-completion-commit.ts'), 'utf8');
const muxCount = (nonCommentText(muxContent).match(/evaluateCompletionEvidence\(/g) || []).length;
const autoFillCount = (nonCommentText(autoFillContent).match(/evaluateCompletionEvidence\(/g) || []).length;
if (muxCount !== MUX_PREDICATE_CALLSITES) {
  process.stderr.write(`B-1SEAM: evaluateCompletionEvidence( in mux-runner.ts = ${muxCount}, expected exactly ${MUX_PREDICATE_CALLSITES}\n`);
  failures++;
}
if (autoFillCount !== 1) {
  process.stderr.write(`B-1SEAM: evaluateCompletionEvidence( in auto-fill-completion-commit.ts = ${autoFillCount}, expected exactly 1\n`);
  failures++;
}

// Pin 4: defaultDoneGuard routes through the predicate; no bare field-presence accept.
const doneGuard = extractTopLevelFunction(muxContent, 'function defaultDoneGuard(', 'pin 4');
if (doneGuard && !doneGuard.includes('evaluateCompletionEvidence(')) {
  process.stderr.write('B-1SEAM: defaultDoneGuard body missing evaluateCompletionEvidence( (accept-here-revert-there split)\n');
  failures++;
}
if (doneGuard && /\.length\s*>\s*0/.test(doneGuard)) {
  process.stderr.write('B-1SEAM: defaultDoneGuard contains a bare .length > 0 field-presence accept\n');
  failures++;
}

// Pin 5: the Done-flip guard routes through the predicate (predicate UNDER the guard).
const guard = extractTopLevelFunction(muxContent, 'export function guardCompletionCommitBeforeDone(', 'pin 5');
if (guard && !guard.includes('evaluateCompletionEvidence(')) {
  process.stderr.write('B-1SEAM: guardCompletionCommitBeforeDone body missing evaluateCompletionEvidence(\n');
  failures++;
}

if (failures > 0) process.exit(1);
console.log(`audit-trap-door-enforcement: B-1SEAM completion-predicate single-seam verified (mux callsites: ${muxCount}, auto-fill: ${autoFillCount})`);
NODE
then
  audit_exit_code=1
fi

# R-AFCC-DEEP-CONSOLIDATED: single oracle — verify surviving entry points present and pruned exports absent
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

const requiredExports = [
  'export function readEvidence',
  'export function persistEvidence',
  'export function gateForPhantomDoneRevert',
];

const prunedExports = [
  'export function gateForDoneFlip',
  'export function recordPostGateOutcome',
];

let failures = 0;

for (const sym of requiredExports) {
  if (!text.includes(sym)) {
    process.stderr.write(`R-AFCC-DEEP-CONSOLIDATED: required export missing: "${sym}" in ticket-completion-evidence.ts\n`);
    failures++;
  }
}

for (const sym of prunedExports) {
  if (text.includes(sym)) {
    process.stderr.write(`R-AFCC-DEEP-CONSOLIDATED: pruned export re-introduced: "${sym}" in ticket-completion-evidence.ts\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-DEEP-CONSOLIDATED oracle surface verified');
NODE
then
  audit_exit_code=1
fi

# AC-8 MCP forwarding invariant: verify trap door entry present in services/CLAUDE.md with all required labels
if ! node - "$EXTENSION_ROOT/src/services/CLAUDE.md" <<'NODE'
const fs = require('fs');

const [,, claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(AC-8 MCP forwarding invariant)'));

if (!entry) {
  process.stderr.write('AC-8 MCP forwarding invariant: trap-door entry not found in extension/src/services/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`AC-8 MCP forwarding invariant: trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: AC-8 MCP forwarding invariant trap-door verified');
NODE
then
  audit_exit_code=1
fi

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-RASO attributable-frontmatter-sha single oracle)'));

if (!entry) {
  process.stderr.write('R-RASO attributable-frontmatter-sha single oracle: trap-door entry not found in extension/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-RASO attributable-frontmatter-sha single oracle: trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-RASO attributable-frontmatter-sha single oracle trap-door verified');
NODE
then
  audit_exit_code=1
fi

exit "$audit_exit_code"
