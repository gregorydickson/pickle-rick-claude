// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(__dirname, '../../.claude/agents/morty-course-corrector.md');

function frontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(match, 'morty-course-corrector must have frontmatter');
  const result = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(': ');
    if (colon === -1) continue;
    result[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return result;
}

test('morty-course-corrector agent is read-only', () => {
  const content = readFileSync(agentPath, 'utf8');
  const fm = frontmatter(content);
  const tools = fm.tools.split(',').map((tool) => tool.trim());

  assert.equal(fm.name, 'morty-course-corrector');
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep']);
  assert.equal(tools.includes('Edit'), false);
  assert.equal(tools.includes('Write'), false);
  assert.equal(tools.includes('Bash'), false);
  assert.match(content, /Do not modify project source, ticket directories, `state\.json`, `active`, `completion_promise`/);
});

test('morty-course-corrector names the real correct-course entry point, not a missing slash command', () => {
  const fm = frontmatter(readFileSync(agentPath, 'utf8'));
  assert.match(fm.description, /`correct-course\.js`/);
  assert.doesNotMatch(readFileSync(agentPath, 'utf8'), /pickle-correct-course/);
});
