// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const commandsDir = path.resolve(__dirname, '../../.claude/commands');

function readCommand(filename) {
  return fs.readFileSync(path.join(commandsDir, filename), 'utf8');
}

function readRepoFile(filename) {
  return fs.readFileSync(path.join(repoRoot, filename), 'utf8');
}

const citadel = readCommand('citadel.md');
const helpPickle = readCommand('help-pickle.md');
const cronenberg = readCommand('cronenberg.md');
const readme = readRepoFile('README.md');
const commandReference = readRepoFile('COMMANDS.md');
const prdGuide = readRepoFile('PRD_GUIDE.md');

describe('citadel command surface', () => {
  test('citadel slash command exists and documents primary flags', () => {
    assert.match(citadel, /^# \/citadel$/m);
    for (const flag of ['--prd <prd_path>', '--diff <base..head>', '--strict', '--report <path>', '--print-stubs']) {
      assert.match(citadel, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('help-pickle exposes citadel as a conformance phase', () => {
    assert.match(helpPickle, /\/citadel --prd <path>/);
    assert.match(helpPickle, /conformance audit/i);
    assert.match(helpPickle, /--print-stubs/);
  });

  test('cronenberg defines citadel risk and routes citadel before anatomy-park', () => {
    assert.match(cronenberg, /`CITADEL_RISK`/);
    assert.match(cronenberg, /conformance.*acceptance criteria.*spec compliance.*audit against PRD/s);

    const citadelRouteIndex = cronenberg.indexOf('| `CITADEL_RISK` | `/citadel --prd <prd_path>` |');
    const anatomyRouteIndex = cronenberg.indexOf('| `SUBSYSTEM_TOUCHES ≥ 2` | `/anatomy-park` |');
    assert.ok(citadelRouteIndex > 0, 'missing CITADEL_RISK followup row');
    assert.ok(anatomyRouteIndex > citadelRouteIndex, 'citadel must run before anatomy-park');
  });

  test('cronenberg plan prints the conformance signal label', () => {
    assert.match(cronenberg, /Signals: .*conformance=<y\/n>/);
    assert.doesNotMatch(cronenberg, /citadel-risk=<y\/n>/);
  });

  test('cronenberg preserves pickle-pipeline duplicate-followup suppression', () => {
    const step4Start = cronenberg.indexOf('## Step 4: Pick Followups');
    const step5Start = cronenberg.indexOf('## Step 5: Print Plan');
    const step4 = cronenberg.slice(step4Start, step5Start);

    assert.match(step4, /chosen metaphor is `\/pickle-pipeline`/);
    assert.match(step4, /chains citadel \+ anatomy-park \+ szechuan-sauce internally/);
    assert.match(step4, /followups would duplicate/);
  });

  test('command reference documents citadel and its flags', () => {
    assert.match(commandReference, /\| `\/citadel --prd <path>` \|/);
    for (const flag of ['--prd <path>', '--diff <base..head>', '--strict', '--report <path>', '--print-stubs']) {
      assert.match(commandReference, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  test('README documents citadel pipeline order, reports, and cronenberg routing', () => {
    assert.match(readme, /build → citadel → anatomy-park → szechuan-sauce/);
    assert.match(readme, /`schema: "1\.0"`/);
    assert.match(readme, /<session>\/citadel_report\.json/);

    const citadelRouteIndex = readme.indexOf('| `CITADEL_RISK`');
    const anatomyRouteIndex = readme.indexOf('| `SUBSYSTEM_TOUCHES ≥ 2` | `/anatomy-park` |');
    assert.ok(citadelRouteIndex > 0, 'README missing CITADEL_RISK followup row');
    assert.ok(anatomyRouteIndex > citadelRouteIndex, 'README must list citadel before anatomy-park');
  });

  test('PRD guide lists citadel as post-implementation conformance audit', () => {
    assert.match(prdGuide, /\| `\/citadel --prd <path>` \| Post-implementation conformance audit/);
  });
});
