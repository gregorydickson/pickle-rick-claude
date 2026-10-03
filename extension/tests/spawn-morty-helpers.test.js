// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TIER_LIFECYCLE } from '../services/pickle-utils.js';
import {
  buildTierLifecycleSections,
  buildWorkerPrompt,
  isPhasePersonasEnabled,
  resolveEffectiveTimeout,
  resolvePhasePersonaModel,
  resolveWorkerModelFromTierAndPersona,
} from '../bin/spawn-morty.js';

function makeTmpDir(prefix = 'pickle-spawn-morty-helpers-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function baseTicket(repoRoot) {
  return {
    task: 'implement helper tests',
    ticketContent: '# Ticket',
    ticketId: 'ticket-helper',
    ticketPath: path.join(repoRoot, 'ticket-helper'),
    sessionRoot: repoRoot,
    backend: 'claude',
    isReviewTicket: false,
  };
}

function writePhasePersonaFixture(extensionRoot, agentsDir, step = 'implement') {
  fs.mkdirSync(path.join(extensionRoot, 'extension', 'data'), { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'persona.md'), 'Base Rick voice.');
  fs.writeFileSync(path.join(extensionRoot, 'extension', 'data', 'phase-personas.json'), JSON.stringify({
    version: 1,
    [step]: {
      subagent_type: 'morty-phase-implementer',
      complexity_tier_default: 'large',
      model: 'opus',
    },
  }, null, 2));
  fs.writeFileSync(path.join(agentsDir, 'morty-phase-implementer.md'), [
    '---',
    'name: morty-phase-implementer',
    'description: Implementer',
    'tools: Read, Edit, Write, Bash, Glob, Grep',
    'model: opus',
    'role: phase-implementer',
    'identity: Apply the plan.',
    'communication_style: terse',
    'principles[]: ["Do the work."]',
    '---',
    '',
    'Phase implementer specialization.',
    '',
  ].join('\n'));
}

function withPhasePersonaEnv(value, fn) {
  const previous = process.env.PICKLE_PHASE_PERSONAS;
  if (value === undefined) delete process.env.PICKLE_PHASE_PERSONAS;
  else process.env.PICKLE_PHASE_PERSONAS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PICKLE_PHASE_PERSONAS;
    else process.env.PICKLE_PHASE_PERSONAS = previous;
  }
}

test('F1-3: buildWorkerPrompt no longer injects a legacy session project-context.md', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, 'project-context.md'), 'Architecture\n- Existing shape');
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });

    const ticketIndex = prompt.indexOf('# TARGET TICKET CONTENT');
    const executionIndex = prompt.indexOf('# EXECUTION CONTEXT');

    assert.equal(prompt.includes('## Project Context'), false);
    assert.equal(prompt.includes('- Existing shape'), false);
    assert.ok(ticketIndex > -1 && ticketIndex < executionIndex, 'target ticket content should precede execution context');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: includes acceptance-criteria ownership guidance', () => {
  const repoRoot = makeTmpDir();
  try {
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(prompt.includes('Treat `[worker]` criteria and untagged criteria as worker-owned.'));
    assert.ok(prompt.includes('Manager Handoff'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: injects active persona between template and ticket content when enabled', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    const prompt = withPhasePersonaEnv('on', () => {
      return buildWorkerPrompt({
        ticket: baseTicket(repoRoot),
        model: 'opus',
        repoRoot,
        extensionRoot,
        agentsDir,
      });
    });

    const templateIndex = prompt.indexOf('implement helper tests');
    const personaIndex = prompt.indexOf('## Active Persona\nBase Rick voice.');
    const phaseIndex = prompt.indexOf('Phase implementer specialization.');
    const ticketIndex = prompt.indexOf('# TARGET TICKET CONTENT');
    const executionIndex = prompt.indexOf('# EXECUTION CONTEXT');
    const tailIndex = prompt.indexOf('**IMPORTANT**: You are a localized worker.');

    assert.ok(templateIndex > -1, 'should include template body');
    assert.ok(personaIndex > templateIndex, 'active persona should follow template body');
    assert.ok(phaseIndex > personaIndex, 'phase body should be inside active persona block');
    assert.ok(ticketIndex > phaseIndex, 'target ticket content should follow active persona');
    assert.ok(executionIndex > ticketIndex, 'execution context should follow target ticket content');
    assert.ok(tailIndex > executionIndex, 'localized-worker tail should follow execution context');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: phase personas default off and record disabled event once', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  const logs = [];
  const originalLog = console.log;
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    console.log = (message) => { logs.push(String(message)); };

    const firstPrompt = withPhasePersonaEnv(undefined, () => buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    }));
    const secondPrompt = withPhasePersonaEnv(undefined, () => buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    }));

    assert.equal(firstPrompt.includes('## Active Persona'), false);
    assert.equal(secondPrompt.includes('## Active Persona'), false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /feature available but disabled/);

    const state = JSON.parse(fs.readFileSync(path.join(repoRoot, 'state.json'), 'utf-8'));
    const disabledEvents = state.activity.filter((entry) => entry.event === 'phase_personas_disabled_seen');
    assert.equal(disabledEvents.length, 1);
  } finally {
    console.log = originalLog;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('phase persona enablement: env and settings opt in, model is gated', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir);
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));

    assert.equal(withPhasePersonaEnv(undefined, () => isPhasePersonasEnabled(extensionRoot)), false);
    assert.equal(withPhasePersonaEnv(undefined, () => resolvePhasePersonaModel(repoRoot, extensionRoot)), undefined);
    assert.equal(withPhasePersonaEnv('on', () => isPhasePersonasEnabled(extensionRoot)), true);
    assert.equal(withPhasePersonaEnv('on', () => resolvePhasePersonaModel(repoRoot, extensionRoot)), 'opus');
    assert.equal(withPhasePersonaEnv('off', () => isPhasePersonasEnabled(extensionRoot)), false);

    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify({
      bmad_hardening: { phase_personas_enabled: true },
    }, null, 2));
    assert.equal(withPhasePersonaEnv(undefined, () => isPhasePersonasEnabled(extensionRoot)), true);
    assert.equal(withPhasePersonaEnv('off', () => isPhasePersonasEnabled(extensionRoot)), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits active persona when phase mapping is absent', () => {
  const repoRoot = makeTmpDir();
  const extensionRoot = makeTmpDir('pickle-spawn-morty-extension-');
  const agentsDir = makeTmpDir('pickle-spawn-morty-agents-');
  try {
    writePhasePersonaFixture(extensionRoot, agentsDir, 'research');
    fs.writeFileSync(path.join(repoRoot, 'state.json'), JSON.stringify({ step: 'implement' }, null, 2));
    const prompt = buildWorkerPrompt({
      ticket: baseTicket(repoRoot),
      model: 'sonnet',
      repoRoot,
      extensionRoot,
      agentsDir,
    });

    assert.equal(prompt.includes('## Active Persona'), false);
    assert.equal(prompt.includes('Phase implementer specialization.'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('resolveEffectiveTimeout: clamps configured timeout to remaining wall-clock budget', () => {
  const startEpoch = 1_700_000_000;
  const nowMs = (startEpoch + 555) * 1000;
  const state = {
    max_time_minutes: 10,
    start_time_epoch: startEpoch,
  };

  assert.equal(resolveEffectiveTimeout(300, state, nowMs), 45);
});

test('resolveWorkerModelFromTierAndPersona: ticket tier precedes persona default', () => {
  assert.equal(resolveWorkerModelFromTierAndPersona('large', 'sonnet'), 'opus');
  assert.equal(resolveWorkerModelFromTierAndPersona(undefined, 'opus'), 'opus');
  assert.equal(resolveWorkerModelFromTierAndPersona(undefined, undefined), 'sonnet');
});

// C8a: the shapes are DERIVED from TIER_LIFECYCLE (one tier per distinct phase list), never listed by hand.
const lifecycleShapes = [...new Map(
  Object.entries(TIER_LIFECYCLE).map(([tier, phases]) => [JSON.stringify(phases), { tier, phases }]),
).values()];

test('C8a-1: every lifecycle shape renders the Expected-value source rule', () => {
  assert.ok(lifecycleShapes.length >= 2, 'fixture floor: more than one distinct lifecycle shape');
  for (const { tier, phases } of lifecycleShapes) {
    const out = buildTierLifecycleSections(phases, tier);
    assert.match(out, /Expected-value source:/, `tier ${tier} (${phases.join(',')}) lacks the rule`);
    assert.equal(out.split('Expected-value source:').length - 1, 1, `tier ${tier} renders the rule once`);
  }
});

test('C8a-2: the rule sits outside the per-phase sections, so it cannot depend on a phase being active', () => {
  const out = buildTierLifecycleSections(['implement', 'code_review'], 'trivial');
  const ruleAt = out.indexOf('Expected-value source:');
  const implementAt = out.indexOf('### 1. Implement');
  assert.ok(ruleAt > -1 && implementAt > -1, `both markers render (rule ${ruleAt}, implement ${implementAt})`);
  assert.ok(ruleAt < implementAt);
});
