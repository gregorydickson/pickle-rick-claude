#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { getActivityDir } from '../extension/services/activity-logger.js';
import { readRecoverableJsonObject } from '../extension/services/recoverable-json.js';
import { formatLocalDateKey, getDataRoot } from '../extension/services/pickle-utils.js';
import { StateManager } from '../extension/services/state-manager.js';

const DEFAULT_RUNTIME_ARTIFACT_PATH = path.join(getDataRoot(), 'bundle', 'ac-dr-02.runtime.json');
const sm = new StateManager();

// AC-DR-02 evidence lives ONLY in the session-scoped runtime artifact. A tracked
// bundle/ac-dr-02.json is impossible by construction: it must be content-stable to keep
// the repo tree clean across runs, and a content-stable file cannot carry a run-dependent
// verdict — it can only assert a hardcoded pass. verify-bundle reads `pass` as the AC's
// verdict, so such a file is a permanent false-green. It reports missing instead.
const ARTIFACT_TEMPLATE = {
  ac_id: 'AC-DR-02',
  checker: 'verify-recapture-fired',
  checker_version: '3',
};

const ACTIVITY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

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

// `baseline_recapture_attempted` is emitted by microverse-runner through logActivity(),
// which appends ONLY to getDataRoot()/activity/<local-day>.jsonl. state.json.activity is a
// DIFFERENT sink (writeActivityEntry) that this event never reaches — read the one the
// producer actually writes, or the AC can never pass.
function listActivityFiles(activityDir) {
  try {
    return fs.readdirSync(activityDir).filter((name) => ACTIVITY_FILE_RE.test(name));
  } catch {
    return null;
  }
}

// Activity files are keyed by LOCAL day, and local-day is monotonic in epoch ms, so a file
// older than the window's opening day cannot hold an in-window event — bounding the scan
// here can never drop a match, and keeps a year of retained activity off the read path.
function readActivityEventsSince(activityDir, files, sinceMs) {
  const sinceDayKey = Number.isFinite(sinceMs) ? formatLocalDateKey(new Date(sinceMs)) : null;
  const events = [];
  for (const file of files) {
    if (sinceDayKey !== null && path.basename(file, '.jsonl') < sinceDayKey) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(activityDir, file), 'utf8');
    } catch {
      // An in-window day we cannot READ is the absence of evidence, not evidence of absence.
      // Skipping it would let the scan finish and report `activity_count: 0` — an affirmative
      // claim that a complete scan found nothing. Stop and report no-measurement instead.
      return null;
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
      } catch {
        // A torn or malformed activity line is not evidence; skip it.
      }
    }
  }
  return events;
}

// The activity dir is shared by every session on the host, so an unscoped match would let a
// sibling session's recapture satisfy THIS session's AC. Attribution is required, not optional.
function findMatchingEvent(activity, windows, sessionName) {
  return activity.find((entry) => (
    entry?.event === 'baseline_recapture_attempted'
    && entry?.session === sessionName
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
      return 'Ensure the pickle activity log directory (getDataRoot()/activity) exists and is readable before rerunning AC-DR-02.';
    case 'phase-window-missing':
      return 'Ensure anatomy-park phase transitions are appended to state.history before rerunning AC-DR-02.';
    case 'recapture-event-missing':
      return 'Ensure anatomy-park logs baseline_recapture_attempted to activity/<day>.jsonl, stamped with this session, inside its latest anatomy-park phase window.';
    default:
      return null;
  }
}

function writeRuntimeArtifact(artifactPath, { pass, failureReason, evidence }) {
  const artifact = {
    ...ARTIFACT_TEMPLATE,
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

export function verifyRecaptureFired(sessionRoot) {
  const statePath = sessionRoot ? path.join(sessionRoot, 'state.json') : null;
  const artifactPath = runtimeArtifactPath(sessionRoot);
  const activityDir = getActivityDir();
  if (!statePath) {
    return {
      exitCode: 2,
      artifactPath,
      artifact: writeRuntimeArtifact(artifactPath, {
        pass: false,
        failureReason: 'state-missing',
        evidence: { state_path: statePath, activity_dir: activityDir, activity_count: null, anatomy_windows: [] },
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
        evidence: { state_path: statePath, activity_dir: activityDir, activity_count: null, anatomy_windows: [] },
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
          activity_dir: activityDir,
          read_error: err instanceof Error ? err.message : String(err),
          activity_count: null,
          anatomy_windows: [],
        },
      }),
    };
  }

  const sessionName = path.basename(sessionRoot);
  const activityFiles = listActivityFiles(activityDir);
  const latestWindow = latestAnatomyWindow(state.history);
  const windows = latestWindow ? [latestWindow] : [];
  // With no anatomy window the verdict is `phase-window-missing`, decided by state.history
  // alone — no activity event can change it. Reading anyway passed NaN as the day bound, which
  // DISABLES it (`Number.isFinite` above), so the failure path scanned every retained activity
  // file: measured 7 files / 381,795 events / 1358MB heap / 3.4s on a six-day host, growing
  // without bound. Skip the read; `activity_count: null` then reports honestly that nothing was
  // measured, exactly as the activity-missing arm already does.
  const activity = activityFiles === null || latestWindow === null
    ? null
    : readActivityEventsSince(activityDir, activityFiles, latestWindow.start);
  const matchingEvent = activity ? findMatchingEvent(activity, windows, sessionName) : null;
  // ONE no-measurement state, two producers: an unlistable activity DIR, or an in-window DAY
  // file that could not be read. Both mean "the activity log could not be read" and both take
  // the SAME operator repair, so they collapse onto `activity-missing` rather than adding a
  // sixth failure_reason. Reporting `recapture-event-missing` instead asserts a scan that
  // never completed and sends the operator at the producer instead of at the permissions.
  const activityUnreadable = activityFiles === null || (windows.length > 0 && activity === null);
  const failureReason = activityUnreadable
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
        activity_dir: activityDir,
        session: sessionName,
        activity_count: activity ? activity.length : null,
        anatomy_windows: artifactWindows(windows),
        matched_event: matchingEvent,
      },
    }),
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-recapture-fired.js') {
  try {
    const sessionRoot = process.argv[2] ?? process.env.PICKLE_SESSION_ROOT;
    const result = verifyRecaptureFired(sessionRoot);
    process.stdout.write(`AC-DR-02 ${result.artifact.pass ? 'PASS' : 'FAIL'} ${result.artifactPath}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
