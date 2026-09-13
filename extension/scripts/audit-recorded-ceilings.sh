#!/usr/bin/env bash
# audit-recorded-ceilings.sh — B-RATCHET R1: a recorded ceiling is a ratchet, not a comment.
#
# A carve-out marker is a `// eslint-disable-next-line <rules> -- HT-1 reviewed: measured ...` directive
# that RECORDS the figures of the function it silences (`N code lines` for max-lines-per-function,
# `complexity N` for complexity). Markers are DISCOVERED by parsing extension/src/**/*.ts — there is no
# list of functions or files to maintain. For every figure-carrying marker this audit:
#   R1-1  fails when the measured value EXCEEDS the record (the function grew under its silence);
#   R1-2  fails when a disabled ceiling rule has no figure, or an ambiguous / unbound one;
#   R1-3  fails when the measured value is BELOW the record, naming the number to write.
# Directives with no recorded figures (scoped disables, figure-less HT-1 reviews) are ignored (R1-4).
#
# Measurement is eslint's own: the marker file is linted with inline config OFF, parser only, and both
# rules at max 0 so every function reports its number. Rule options (skipBlankLines/skipComments) are
# read from the project config, not restated here.
#
# RECORDED_CEILINGS_ROOT_OVERRIDE=<dir> scans <dir>/src instead of extension/src (fixture tests).
# A gate that refuses a COMMIT/release — never a run. Exits non-zero on any finding.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN_ROOT="${RECORDED_CEILINGS_ROOT_OVERRIDE:-$EXTENSION_ROOT}"

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

node - "$EXTENSION_ROOT" "$SCAN_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const [, , extensionRoot, scanRoot] = process.argv;
const failures = [];
const fail = (msg) => failures.push(msg);

const DIRECTIVE_RE = /^\s*\/\/\s*eslint-disable-next-line\s+(.+?)(?:\s+--\s+(.*))?$/;
const REVIEW_TOKEN = 'HT-1 reviewed:';
// The recorded-figure grammar, one entry per ceiling rule in eslint.config.js.
const FIGURES = {
  'max-lines-per-function': { record: /\b(\d+) code lines\b/g, measured: /too many lines \((\d+)\)/ },
  complexity: { record: /\bcomplexity (\d+)\b/g, measured: /complexity of (\d+)/ },
};

function listTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// One carve-out per figure-carrying directive; figure-less directives are counted and ignored.
function discover(files) {
  const markers = [];
  let ignored = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      const match = DIRECTIVE_RE.exec(text);
      if (!match) return;
      const [, ruleList, justification = ''] = match;
      const records = Object.entries(FIGURES).map(([rule, g]) => [rule, [...justification.matchAll(g.record)].map(m => Number(m[1]))]);
      const hasFigure = records.some(([, values]) => values.length > 0);
      const isCarveOut = justification.includes(REVIEW_TOKEN) && (hasFigure || /\bmeasured\b/.test(justification));
      if (!isCarveOut) {
        ignored += 1;
        return;
      }
      const rules = ruleList.split(',').map(r => r.trim());
      markers.push({ file, line: index + 1, rules, records: new Map(records) });
    });
  }
  return { markers, ignored };
}

async function measure(eslintModule, tseslint, file, markers) {
  const { ESLint } = eslintModule;
  const projectPath = path.join(extensionRoot, path.relative(scanRoot, file));
  const projectConfig = await new ESLint({ cwd: extensionRoot }).calculateConfigForFile(projectPath);
  const rules = {};
  for (const rule of Object.keys(FIGURES)) {
    const options = projectConfig?.rules?.[rule]?.[1];
    if (!options) {
      fail(`${file}: project eslint config carries no options for ${rule}; cannot measure`);
      return;
    }
    rules[rule] = ['error', { ...options, max: 0 }];
  }
  const linter = new ESLint({
    cwd: path.dirname(file),
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules }],
  });
  const [result] = await linter.lintText(fs.readFileSync(file, 'utf8'), { filePath: file });
  const fatal = result.messages.find(m => m.fatal);
  if (fatal) {
    fail(`${file}:${fatal.line} cannot be parsed: ${fatal.message}`);
    return;
  }
  for (const marker of markers) checkMarker(marker, result.messages);
}

function checkMarker(marker, messages) {
  const where = `${path.relative(scanRoot, marker.file)}:${marker.line}`;
  for (const [rule, values] of marker.records) {
    if (values.length > 0 && !marker.rules.includes(rule)) {
      fail(`R1-2 ${where} records a ${rule} figure but the directive does not disable ${rule}`);
    }
  }
  for (const rule of marker.rules.filter(r => r in FIGURES)) {
    const values = marker.records.get(rule);
    const message = messages.find(m => m.ruleId === rule && m.line === marker.line + 1);
    const fn = message?.message.match(/'([^']+)'/)?.[1] ?? '<unknown function>';
    if (values.length !== 1) {
      fail(`R1-2 ${where} ${fn} ${rule}: expected exactly one recorded figure, found ${values.length} — a carve-out must state its number`);
      continue;
    }
    const measured = Number(message?.message.match(FIGURES[rule].measured)?.[1]);
    if (!message || !Number.isInteger(measured)) {
      fail(`R1-2 ${where} ${rule}: the directive precedes no function eslint can measure`);
      continue;
    }
    const recorded = values[0];
    if (measured > recorded) {
      fail(`R1-1 ${where} ${fn} ${rule}: measured ${measured} exceeds recorded ${recorded} — the function grew past its recorded ceiling`);
    } else if (measured < recorded) {
      fail(`R1-3 ${where} ${fn} ${rule}: measured ${measured} is below recorded ${recorded} — lower the record to ${measured}`);
    }
  }
}

(async () => {
  const files = listTsFiles(path.join(scanRoot, 'src'));
  if (files.length === 0) fail(`no .ts files under ${path.join(scanRoot, 'src')} — a scan that reached nothing is not clean`);
  const { markers, ignored } = discover(files);
  if (markers.length > 0) {
    const req = createRequire(path.join(extensionRoot, 'package.json'));
    const eslintModule = req('eslint');
    const tseslint = req('typescript-eslint');
    const byFile = new Map();
    for (const marker of markers) byFile.set(marker.file, [...(byFile.get(marker.file) ?? []), marker]);
    for (const [file, fileMarkers] of byFile) await measure(eslintModule, tseslint, file, fileMarkers);
  }
  for (const msg of failures) process.stderr.write(`audit-recorded-ceilings: ${msg}\n`);
  process.stdout.write(`audit-recorded-ceilings: ${files.length} files scanned, ${markers.length} carve-outs checked, ${ignored} figure-less directives ignored\n`);
  process.exit(failures.length > 0 ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`audit-recorded-ceilings: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
NODE
