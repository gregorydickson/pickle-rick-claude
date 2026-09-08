// @tier: integration
// Exercises extension/scripts/ci-repro.sh's runner-release resolution and exit-code
// discrimination without a real `gh`/`docker` — both are PATH-shimmed shell scripts, so no
// network, no docker daemon, and no GitHub auth are required. Uses the `--print-env` seam
// (exits before the docker check) for the resolution tests, and a shimmed `docker` for the
// provisioning-exit-code test, mirroring the PATH-shim pattern in council-publish.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'extension', 'scripts', 'ci-repro.sh');
const SPAWN_TIMEOUT_MS = 20_000;

function mkTmp(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeExecutable(filePath, contents) {
    fs.writeFileSync(filePath, contents, { mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
}

function writeFixtureWorkflow(dir) {
    const p = path.join(dir, 'ci.yml');
    fs.writeFileSync(p, [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  gate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        "      - uses: actions/setup-node@v4",
        '        with:',
        "          node-version: '22.x'",
        '      - name: Gate',
        '        run: cd extension && npm ci && npm test',
        '',
    ].join('\n'));
    return p;
}

// `gh run list --workflow=X --status completed --limit N --json databaseId --jq '.[].databaseId'`
// prints `runIds` (newest-first) one per line; `gh run view <id> --log` prints
// `logsById[id]` verbatim, or exits 1 if the id has no entry.
function makeGhShim(dir, { runIds, logsById }) {
    const ghPath = path.join(dir, 'gh');
    const idsFile = path.join(dir, 'run-ids.txt');
    fs.writeFileSync(idsFile, runIds.map(String).join('\n') + (runIds.length ? '\n' : ''));
    for (const [id, log] of Object.entries(logsById)) {
        fs.writeFileSync(path.join(dir, `log-${id}.txt`), log);
    }
    writeExecutable(ghPath, [
        '#!/bin/sh',
        'HERE="$(cd "$(dirname "$0")" && pwd)"',
        'if [ "$1" = "run" ] && [ "$2" = "list" ]; then',
        '  cat "$HERE/run-ids.txt"',
        '  exit 0',
        'fi',
        'if [ "$1" = "run" ] && [ "$2" = "view" ]; then',
        '  runid="$3"',
        '  logfile="$HERE/log-$runid.txt"',
        '  if [ -f "$logfile" ]; then cat "$logfile"; exit 0; else exit 1; fi',
        'fi',
        'exit 1',
        '',
    ].join('\n'));
}

// docker version -> ok; docker image inspect -> "not found" (forces provision); docker rm -> ok;
// docker build -> drains stdin, ok; docker run (the provisioning step) -> drains stdin, FAILS,
// simulating an apt/network flake inside the container.
function makeFlakyDockerShim(dir) {
    const dockerPath = path.join(dir, 'docker');
    writeExecutable(dockerPath, [
        '#!/bin/sh',
        'case "$1" in',
        '  version) exit 0 ;;',
        '  image) exit 1 ;;',
        '  rm) exit 0 ;;',
        '  build) cat >/dev/null; exit 0 ;;',
        '  run) cat >/dev/null; exit 7 ;;',
        '  commit) exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
    ].join('\n'));
}

function runCiRepro(args, { shimDir, extraShimDirs = [] }) {
    const dirs = [shimDir, ...extraShimDirs, process.env.PATH];
    return spawnSync('bash', [SCRIPT, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: dirs.join(path.delimiter) },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
    });
}

test('resolve_runner_release skips a completed run with no Image line and lands on the next one', () => {
    const shimDir = mkTmp('pickle-ci-repro-gh-');
    const workflowDir = mkTmp('pickle-ci-repro-wf-');
    try {
        const workflow = writeFixtureWorkflow(workflowDir);
        // Newest-first, matching real `gh run list` ordering: 9001 is the in-flight run with no
        // Image line yet, 9002 is the completed run one step older that carries it.
        makeGhShim(shimDir, {
            runIds: [9001, 9002],
            logsById: {
                9001: 'Requested labels: ubuntu-latest\nPreparing runner...\n',
                9002: 'Requested labels: ubuntu-latest\nImage: ubuntu-24.04\nRunner: ...\n',
            },
        });

        const result = runCiRepro(['--print-env', '--workflow', workflow], { shimDir });

        assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
        assert.match(result.stdout, /runner release\s+: ubuntu:24\.04 — observed as 'Image: ubuntu-24\.04' in run 9002 of ci\.yml/);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.rmSync(workflowDir, { recursive: true, force: true });
    }
});

test('resolve_runner_release still refuses (exit 2) when no completed run exists', () => {
    const shimDir = mkTmp('pickle-ci-repro-gh-');
    const workflowDir = mkTmp('pickle-ci-repro-wf-');
    try {
        const workflow = writeFixtureWorkflow(workflowDir);
        makeGhShim(shimDir, { runIds: [], logsById: {} });

        const result = runCiRepro(['--print-env', '--workflow', workflow], { shimDir });

        assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
        assert.match(result.stderr, /no completed run of ci\.yml found/);
        assert.match(result.stderr, /Re-run with --runner-release/);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.rmSync(workflowDir, { recursive: true, force: true });
    }
});

test('a provisioning flake (apt/network inside the container) exits 4, distinct from a harness refusal', () => {
    const shimDir = mkTmp('pickle-ci-repro-docker-');
    const workflowDir = mkTmp('pickle-ci-repro-wf-');
    try {
        const workflow = writeFixtureWorkflow(workflowDir);
        makeFlakyDockerShim(shimDir);

        // --runner-release bypasses gh entirely; this test is about the provisioning exit code,
        // not release resolution.
        const result = runCiRepro(
            ['--workflow', workflow, '--runner-release', '24.04', '--cmd', 'true'],
            { shimDir },
        );

        assert.equal(result.status, 4, `expected exit 4, got ${result.status}\nstderr: ${result.stderr}`);
        assert.match(result.stderr, /provisioning failed/);
        assert.match(result.stderr, /retryable/);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.rmSync(workflowDir, { recursive: true, force: true });
    }
});

test('provisioning_die is used at exactly its definition and the two provisioning-failure call sites', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const matches = src.match(/provisioning_die/g) || [];
    assert.equal(matches.length, 3, 'expected 1 definition + 2 call sites (build_base_image, provision)');
});

test('the structural docker-absent refusal is unchanged: still die() (exit 2), not provisioning_die()', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /command -v docker >\/dev\/null 2>&1 \|\| die "docker not found on PATH"/);
});
