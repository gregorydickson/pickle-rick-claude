// @tier: expensive
//
// AC-MFW-7-1: real-subprocess MCP forwarding integration test.
//
// Spawns a real 'claude -p' worker with a fixture MCP config that registers
// a synthetic echo MCP server. The worker invokes the echo tool and writes
// the response to ${ticketDir}/mcp-probe.txt. Asserts the probe file exists
// with the echoed content.
//
// Gated on RUN_EXPENSIVE_TESTS=1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWorkerInvocation } from '../../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_MCP_SERVER = path.resolve(__dirname, 'fixtures/echo-mcp-server.js');
const ECHO_MESSAGE = 'hello-mcp-test';
// 4-minute timeout for the real claude subprocess
const TEST_TIMEOUT_MS = 240_000;

test(
  'AC-MFW-7-1: real worker subprocess can invoke echo tool via forwarded MCP config',
  { timeout: TEST_TIMEOUT_MS + 30_000 },
  async (t) => {
    if (!process.env.RUN_EXPENSIVE_TESTS) {
      t.skip('set RUN_EXPENSIVE_TESTS=1 to run MCP subprocess integration test');
      return;
    }

    // Verify claude CLI is available
    const claudeCheck = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (claudeCheck.error || claudeCheck.status !== 0) {
      t.skip('claude CLI not available in PATH');
      return;
    }

    // Verify the echo MCP server fixture exists
    assert.ok(
      fs.existsSync(ECHO_MCP_SERVER),
      `echo-mcp-server.js fixture must exist at ${ECHO_MCP_SERVER}`,
    );

    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-worker-'));
    const ticketId = 'mcp-test-ticket';
    const ticketDir = path.join(sessionRoot, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const probeFile = path.join(ticketDir, 'mcp-probe.txt');

    try {
      // Write fixture MCP config pointing to the echo server
      const mcpConfig = {
        mcpServers: {
          echo: {
            command: 'node',
            args: [ECHO_MCP_SERVER],
          },
        },
      };
      const mcpConfigPath = path.join(sessionRoot, 'mcp-config.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

      // Prompt: call the echo tool then write the result to the probe file
      const prompt =
        `You have access to an MCP tool named "echo" from the "echo" MCP server. ` +
        `Please call that tool with the argument message="${ECHO_MESSAGE}". ` +
        `After the tool returns, write the exact text it returned (nothing else) to ` +
        `the file at this absolute path: ${probeFile}`;

      // Build the argv through the PRODUCTION worker dispatcher, fed the operator
      // override exactly as spawn-morty does, so the forwarding under test is the
      // shipped `--mcp-config` push rather than a hand-assembled flag list.
      const prevDataRoot = process.env.PICKLE_DATA_ROOT;
      process.env.PICKLE_DATA_ROOT = sessionRoot;
      let invocation;
      try {
        invocation = buildWorkerInvocation('claude', {
          prompt,
          addDirs: [sessionRoot],
          settingsBag: { worker_mcp_config_path: mcpConfigPath },
        });
      } finally {
        if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevDataRoot;
      }
      const mcpFlagAt = invocation.args.indexOf('--mcp-config');
      assert.ok(
        mcpFlagAt >= 0 && invocation.args[mcpFlagAt + 1] === mcpConfigPath,
        `production worker argv must forward --mcp-config ${mcpConfigPath}; got: ${JSON.stringify(invocation.args.slice(0, -1))}`,
      );

      const result = spawnSync(invocation.cmd, invocation.args, {
        encoding: 'utf8',
        timeout: TEST_TIMEOUT_MS,
        cwd: sessionRoot,
        env: { ...process.env },
      });

      assert.equal(
        result.status,
        0,
        `claude -p exited non-zero (${result.status}): ${result.stderr?.slice(0, 500)}`,
      );

      assert.ok(
        fs.existsSync(probeFile),
        `mcp-probe.txt must exist at ${probeFile}; stdout: ${result.stdout?.slice(0, 300)}`,
      );

      const probeContent = fs.readFileSync(probeFile, 'utf8').trim();
      assert.ok(
        probeContent.includes(ECHO_MESSAGE),
        `mcp-probe.txt must contain echoed message "${ECHO_MESSAGE}"; got: "${probeContent}"`,
      );
    } finally {
      fs.rmSync(sessionRoot, { recursive: true, force: true });
    }
  },
);
