// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', '_pickle-manager-prompt.md');
const SPAWN_MORTY_SRC = path.resolve(__dirname, '..', 'src', 'bin', 'spawn-morty.ts');

const templateContent = readFileSync(TEMPLATE_PATH, 'utf-8');

test('AC-7: WORKER_SPAWN_CONTENDED sentinel prefix appears in both spawn-morty.ts and the manager template', () => {
  const spawnMortyContent = readFileSync(SPAWN_MORTY_SRC, 'utf-8');
  assert.match(spawnMortyContent, /WORKER_SPAWN_CONTENDED:/);
  assert.match(templateContent, /WORKER_SPAWN_CONTENDED:/);
});

test('AC-7b: on the sentinel, the template forbids both cleanup arms and forbids flipping status or incrementing iteration', () => {
  const cleanupIdx = templateContent.indexOf('**Cleanup**');
  assert.ok(cleanupIdx !== -1, 'Cleanup step not found');
  const cleanupSection = templateContent.slice(cleanupIdx, cleanupIdx + 1200);
  assert.match(cleanupSection, /WORKER_SPAWN_CONTENDED/);
  assert.match(cleanupSection, /Run NEITHER cleanup arm/i);
  assert.match(cleanupSection, /no `git restore`, no scoped commit/i);
  assert.match(cleanupSection, /do not flip the ticket's status, do not increment iteration/i);
});

test('AC-7c: the worker-spawn-discipline paragraph no longer claims a ceiling-cut re-spawn simply resumes, and names contention as expected/non-fatal', () => {
  const disciplineIdx = templateContent.indexOf('Worker-spawn discipline');
  assert.ok(disciplineIdx !== -1, 'worker-spawn-discipline paragraph not found');
  const disciplineSection = templateContent.slice(disciplineIdx, disciplineIdx + 1800);
  assert.match(disciplineSection, /WORKER_SPAWN_CONTENDED/);
  assert.match(disciplineSection, /EXPECTED and NON-FATAL/i);
  assert.doesNotMatch(
    disciplineSection,
    /simply re-spawn the SAME `spawn-morty\.js` command in the foreground on your next turn — the worker RESUMES from its on-disk artifacts/
  );
});

test('AC-7d: the template states the same-ticket contention disposition — left non-terminal, re-spawned later', () => {
  const disciplineIdx = templateContent.indexOf('Worker-spawn discipline');
  const disciplineSection = templateContent.slice(disciplineIdx, disciplineIdx + 1800);
  assert.match(disciplineSection, /leave the ticket In Progress and re-spawn again on a later turn/i);
});
