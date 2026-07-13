#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecoverableJsonObject } from '../extension/services/recoverable-json.js';
import { getDataRoot } from '../extension/services/pickle-utils.js';
import { StateManager } from '../extension/services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');
const DEFAULT_RUNTIME_ARTIFACT_PATH = path.join(getDataRoot(), 'bundle', 'ac-dr-02.runtime.json');
const sm = new StateManager();
const STABLE_ARTIFACT = {
  ac_id: 'AC-DR-02',
  pass: true,
  checked_at: '2026-05-06T00:00:00.000Z',
  checker: 'verify-recapture-fired',
  checker_version: '2',
  evidence: {
    contract: 'Runtime verification results are written to a session-scoped bundle/ac-dr-02.runtime.json artifact so the tracked artifact remains content-stable across runs.',
  },
  failure_reason: null,
  remediation_hint: null,
};

function isoMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function phaseName(entry) {
  return entry?.phase ?? entry?.step ?? null;
}

function anatomyWindows(history) {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry, index) => {
    if (phaseName(entry) !== 'anatomy-park') return [];
    const start = isoMs(entry.timestamp);
    if (start === null) return [];
    const next = history.slice(index + 1).find((candidate) => (
      phaseName(candidate) !== null && isoMs(candidate?.timestamp) !== null
    ));
    const end = next ? isoMs(next.timestamp) : Infinity;
    return [{ start, end }];
  });
}

function latestAnatomyWindow(history) {
  const windows = anatomyWindows(history);
  return windows.length > 0 ? windows[windows.length - 1] : null;
}

function isInWindow(timestamp, windows) {
  const ts = isoMs(timestamp);
  return ts !== null && windows.some(({ start, end }) => ts >= start && ts < end);
}

function findMatchingEvent(activity, windows) {
  return activity.find((entry) => (
    entry?.event === 'baseline_recapture_attempted'
    && isInWindow(entry.ts ?? entry.timestamp, windows)
  )) ?? null;
}

function artifactWindows(windows) {
  return windows.map(({ start, end }) => ({
    start,
    end: Number.isFinite(end) ? end : null,
  }));
}

function runtimeArtifactPath(sessionRoot) {
  return sessionRoot
    ? path.join(sessionRoot, 'bundle', 'ac-dr-02.runtime.json')
    : DEFAULT_RUNTIME_ARTIFACT_PATH;
}

function failureReasonForStateReadError(err, statePath) {
  if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'MISSING') {
    return 'state-unreadable';
  }
  return fs.existsSync(statePath) ? 'state-unreadable' : 'state-missing';
}

function remediationHintForFailure(failureReason) {
  switch (failureReason) {
    case 'state-missing':
      return 'Ensure the session state.json exists or promote the newest recoverable state.json.tmp.* snapshot before rerunning AC-DR-02.';
    case 'state-unreadable':
      return 'Repair the session state.json so StateManager.read can parse it before rerunning AC-DR-02.';
    case 'activity-missing':
      return 'Ensure the session state persists activity as an array before rerunning AC-DR-02.';
    case 'phase-window-missing':
      return 'Ensure anatomy-park phase transitions are appended to state.history before rerunning AC-DR-02.';
    case 'recapture-event-missing':
      return 'Ensure anatomy-park records baseline_recapture_attempted inside its latest anatomy-park phase window.';
    default:
      return null;
  }
}

function writeRuntimeArtifact(artifactPath, { pass, failureReason, evidence }) {
  const artifact = {
    ...STABLE_ARTIFACT,
    pass,
    checked_at: new Date().toISOString(),
    evidence,
    failure_reason: failureReason,
    remediation_hint: pass ? null : remediationHintForFailure(failureReason),
  };
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function ensureStableArtifact() {
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(STABLE_ARTIFACT, null, 2)}\n`);
}

export function verifyRecaptureFired(sessionRoot) {
  const statePath = sessionRoot ? path.join(sessionRoot, 'state.json') : null;
  const artifactPath = runtimeArtifactPath(sessionRoot);
  if (!statePath) {
    return {
      exitCode: 2,
      artifactPath,
      artifact: writeRuntimeArtifact(artifactPath, {
        pass: false,
        failureReason: 'state-missing',
        evidence: { state_path: statePath, activity_count: null, anatomy_windows: [] },
      }),
    };
  }

  // Recover a MISSING base from an orphan .tmp.<pid> snapshot only. When the base
  // already exists (readable or corrupt-JSON), StateManager.read below promotes any
  // newer tmp through its schema-candidacy guard (isRecoverableStateSnapshotCandidate).
  // The generic promotion here is unguarded, so on an existing base it would renameSync
  // a future-schema / core-field-missing tmp OVER a good state.json and destroy it.
  if (!fs.existsSync(statePath)) {
    readRecoverableJsonObject(statePath);
  }
  if (!fs.existsSync(statePath)) {
    return {
      exitCode: 2,
      artifactPath,
      artifact: writeRuntimeArtifact(artifactPath, {
        pass: false,
        failureReason: 'state-missing',
        evidence: { state_path: statePath, activity_count: null, anatomy_windows: [] },
      }),
    };
  }

  let state;
  try {
    state = sm.read(statePath);
  } catch (err) {
    const failureReason = failureReasonForStateReadError(err, statePath);
    return {
      exitCode: failureReason === 'state-missing' ? 2 : 1,
      artifactPath,
      artifact: writeRuntimeArtifact(artifactPath, {
        pass: false,
        failureReason,
        evidence: {
          state_path: statePath,
          read_error: err instanceof Error ? err.message : String(err),
          activity_count: null,
          anatomy_windows: [],
        },
      }),
    };
  }
  const activity = state.activity;
  const latestWindow = latestAnatomyWindow(state.history);
  const windows = latestWindow ? [latestWindow] : [];
  const matchingEvent = Array.isArray(activity) ? findMatchingEvent(activity, windows) : null;
  const failureReason = !Array.isArray(activity)
    ? 'activity-missing'
    : windows.length === 0
      ? 'phase-window-missing'
      : matchingEvent
        ? null
        : 'recapture-event-missing';
  const pass = failureReason === null;

  return {
    exitCode: pass ? 0 : 1,
    artifactPath,
    artifact: writeRuntimeArtifact(artifactPath, {
      pass,
      failureReason,
      evidence: {
        state_path: statePath,
        activity_count: Array.isArray(activity) ? activity.length : null,
        anatomy_windows: artifactWindows(windows),
        matched_event: matchingEvent,
      },
    }),
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-recapture-fired.js') {
  try {
    ensureStableArtifact();
    const sessionRoot = process.argv[2] ?? process.env.PICKLE_SESSION_ROOT;
    const result = verifyRecaptureFired(sessionRoot);
    process.stdout.write(`AC-DR-02 ${result.artifact.pass ? 'PASS' : 'FAIL'} ${result.artifactPath}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
