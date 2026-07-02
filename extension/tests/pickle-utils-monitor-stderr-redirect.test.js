// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { watcherPaneCommands } from '../services/pickle-utils.js';

const SESSION_DIR = '/tmp/test-session-abc123';
const EXTENSION_ROOT = '/home/user/.claude/pickle-rick';
const BIN_ROOT = path.join(EXTENSION_ROOT, 'extension', 'bin');

const MODES = ['pickle', 'council', 'refinement', 'szechuan-sauce', 'anatomy-park'];

describe('watcherPaneCommands stderr redirect', () => {
  for (const mode of MODES) {
    describe(`mode=${mode}`, () => {
      test('returns 4 pane commands', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        assert.equal(cmds.length, 4);
      });

      test('each command contains 2>> redirect', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        for (const { pane, command } of cmds) {
          assert.ok(
            command.includes('2>>'),
            `pane ${pane} command missing 2>> redirect: ${command}`,
          );
        }
      });

      test('each command redirects to the correct per-pane log path', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        for (const { pane, command } of cmds) {
          const expectedLog = path.join(SESSION_DIR, `monitor-${pane}.log`);
          assert.ok(
            command.includes(expectedLog),
            `pane ${pane} command missing log path "${expectedLog}": ${command}`,
          );
        }
      });

      test('log path uses sessionDir, not deploy root', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        for (const { pane, command } of cmds) {
          assert.ok(
            !command.includes(`${EXTENSION_ROOT}/monitor-${pane}.log`),
            `pane ${pane} command uses deploy root for log path: ${command}`,
          );
          assert.ok(
            command.includes(SESSION_DIR),
            `pane ${pane} command missing sessionDir in log path: ${command}`,
          );
        }
      });

      test('pane 0 command runs monitor.js', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        const pane0 = cmds.find((c) => c.pane === 0);
        assert.ok(pane0, 'pane 0 not found');
        assert.ok(
          pane0.command.includes('monitor.js'),
          `pane 0 command does not include monitor.js: ${pane0.command}`,
        );
      });

      test('pane 0 log is monitor-0.log', () => {
        const cmds = watcherPaneCommands(SESSION_DIR, EXTENSION_ROOT, mode);
        const pane0 = cmds.find((c) => c.pane === 0);
        assert.ok(pane0, 'pane 0 not found');
        const expected = path.join(SESSION_DIR, 'monitor-0.log');
        assert.ok(
          pane0.command.includes(expected),
          `pane 0 command missing monitor-0.log path: ${pane0.command}`,
        );
      });
    });
  }
});
