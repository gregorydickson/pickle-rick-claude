#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$EXTENSION_ROOT/src/bin/mux-runner.ts"

if [ ! -f "$TARGET" ]; then
  echo "audit-phantom-done-call-sites: missing $TARGET" >&2
  exit 1
fi

node - "$TARGET" <<'NODE'
const fs = require('fs');

const [, , filePath] = process.argv;
const source = fs.readFileSync(filePath, 'utf8');

function extractFunctionBody(name) {
  // Try exported function first, then non-exported
  let start = source.indexOf(`export function ${name}(`);
  if (start === -1) start = source.indexOf(`function ${name}(`);
  if (start === -1) {
    throw new Error(`missing function ${name}`);
  }
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`missing opening brace for ${name}`);
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function assertIncludesBefore(body, needle, beforeNeedle, label) {
  const needleIndex = body.indexOf(needle);
  if (needleIndex === -1) throw new Error(`${label}: missing "${needle}"`);
  const beforeIndex = body.indexOf(beforeNeedle);
  if (beforeIndex === -1) throw new Error(`${label}: missing "${beforeNeedle}"`);
  if (needleIndex > beforeIndex) {
    throw new Error(`${label}: "${needle}" must appear before "${beforeNeedle}"`);
  }
}

// --- correctPhantomDoneTickets ---
// R-AFCC-DEEP-3B: decision matrix delegated to batchLoopPhantomDoneKind helper.
// Check: the loop calls the helper before writeTicketStatus.
const phantomBody = extractFunctionBody('correctPhantomDoneTickets');
assertIncludesBefore(
  phantomBody,
  'batchLoopPhantomDoneKind(',
  "if (!writeTicketStatus(input.sessionDir, ticket.id, 'Todo')) continue;",
  'correctPhantomDoneTickets',
);

// --- batchLoopPhantomDoneKind ---
// R-RIC-EXPLICIT-4 / R-AFCC-DEEP-4A: batchLoopPhantomDoneKind delegates to
// gateForPhantomDoneRevert (the ticket-completion-evidence.ts oracle).
// The old hasCompletionCommit/phantomDoneShouldKeepDone direct calls were
// migrated in R-AFCC-DEEP-4A (commit fadc2477). Updated invariant:
// - MUST call gateForPhantomDoneRevert( (new oracle)
// - MUST return 'inferred' (for persist-inferred decisions)
// - MUST return 'explicit-reachable' (for keep decisions)
const batchHelperBody = extractFunctionBody('batchLoopPhantomDoneKind');
if (!batchHelperBody.includes('gateForPhantomDoneRevert(')) {
  throw new Error("batchLoopPhantomDoneKind: missing gateForPhantomDoneRevert call (R-RIC-EXPLICIT-4 / R-AFCC-DEEP-4A)");
}
if (!batchHelperBody.includes("return 'inferred';")) {
  throw new Error("batchLoopPhantomDoneKind: missing 'inferred' return for persist-inferred path (R-RIC-EXPLICIT-4)");
}
if (!batchHelperBody.includes("return 'explicit-reachable';")) {
  throw new Error("batchLoopPhantomDoneKind: missing 'explicit-reachable' return for keep path (R-RIC-EXPLICIT-4)");
}

// --- validateAutoTicketCompletion ---
// B-1SEAM WS-1: evaluateCompletionEvidence (the ONE completion predicate)
// replaces the bare readEvidence call (R-AFCC-DEEP-4A lineage).
// MUST consult the predicate before the no-evidence skip return.
const validateBody = extractFunctionBody('validateAutoTicketCompletion');
assertIncludesBefore(
  validateBody,
  'evaluateCompletionEvidence(',
  "return { action: 'skip', reason: 'no_commit_referencing_ticket_since_current_set' };",
  'validateAutoTicketCompletion',
);
if (!validateBody.includes('!decision.ok')) {
  throw new Error("validateAutoTicketCompletion: missing predicate-refusal branch (B-1SEAM WS-1)");
}

// --- inspectPhantomDoneTicketFile ---
// R-AFCC-DEEP-3B: decision logic delegated to applyInspectPhantomDoneDecision helper.
const inspectBody = extractFunctionBody('inspectPhantomDoneTicketFile');
if (!inspectBody.includes('applyInspectPhantomDoneDecision(')) {
  throw new Error("inspectPhantomDoneTicketFile: missing applyInspectPhantomDoneDecision delegation (R-AFCC-DEEP-3B)");
}

// --- applyInspectPhantomDoneDecision ---
// R-AFCC-DEEP-4A: gateForPhantomDoneRevert replaces hasCompletionCommit.
// Must call gateForPhantomDoneRevert before writeTicketStatus (R-ICP-5 gate ordering).
const applyBody = extractFunctionBody('applyInspectPhantomDoneDecision');
assertIncludesBefore(
  applyBody,
  'gateForPhantomDoneRevert(',
  'writeTicketStatus(',
  'applyInspectPhantomDoneDecision',
);

console.log('audit-phantom-done-call-sites: all phantom-Done gates consult gateForPhantomDoneRevert/readEvidence (R-AFCC-DEEP-4A)');
NODE
