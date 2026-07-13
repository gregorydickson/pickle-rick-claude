import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DebatePersonaName = 'researcher' | 'architect' | 'implementer' | 'skeptic';

export interface DebatePersonaDefinition {
  name: DebatePersonaName;
  title: string;
  role: string;
  identity: string;
  description: string;
  focus: string;
  principles: string[];
}

export const DEBATE_PERSONAS: DebatePersonaDefinition[] = [
  {
    name: 'researcher',
    title: 'Researcher',
    role: 'debater-researcher',
    identity: 'Ground the debate in observed facts, evidence quality, and unknowns.',
    description: 'Pickle Rick debate researcher. Use when /pickle-debate needs evidence-first analysis of the question.',
    focus: 'Surface facts, source quality, missing context, and assumptions that need proof before a decision.',
    principles: [
      'Separate observed evidence from inference.',
      'Prefer concrete repository facts over opinions.',
      'Challenge unsupported claims from other personas.',
    ],
  },
  {
    name: 'architect',
    title: 'Architect',
    role: 'debater-architect',
    identity: 'Evaluate system design, boundaries, coupling, and long-term maintainability.',
    description: 'Pickle Rick debate architect. Use when /pickle-debate needs design and systems analysis.',
    focus: 'Assess architecture fit, failure domains, interfaces, migration paths, and future change cost.',
    principles: [
      'Protect module boundaries and contracts.',
      'Prefer simple designs that age well.',
      'Call out hidden coupling and operational risk.',
    ],
  },
  {
    name: 'implementer',
    title: 'Implementer',
    role: 'debater-implementer',
    identity: 'Evaluate practical execution, sequencing, testability, and delivery risk.',
    description: 'Pickle Rick debate implementer. Use when /pickle-debate needs implementation feasibility analysis.',
    focus: 'Identify the smallest workable path, implementation traps, verification steps, and delivery blockers.',
    principles: [
      'Make the work executable, not theoretical.',
      'Prefer changes that are easy to verify.',
      'Expose sequencing risks before they become rework.',
    ],
  },
  {
    name: 'skeptic',
    title: 'Skeptic',
    role: 'debater-skeptic',
    identity: 'Attack weak assumptions, edge cases, and premature consensus.',
    description: 'Pickle Rick debate skeptic. Use when /pickle-debate needs adversarial critique of a proposal.',
    focus: 'Find counterexamples, missing constraints, downside risk, and reasons the obvious answer may fail.',
    principles: [
      'Disagree when the evidence is weak.',
      'Look for the failure mode people are avoiding.',
      'Demand falsifiable claims and concrete rollback paths.',
    ],
  },
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');

export function debateAgentFilename(persona: DebatePersonaDefinition): string {
  return `morty-debater-${persona.name}.md`;
}

export function renderDebatePersona(persona: DebatePersonaDefinition): string {
  const principles = persona.principles.map((principle) => `"${principle}"`).join(', ');
  return `---
name: morty-debater-${persona.name}
description: ${persona.description}
tools: Read, Glob, Grep
model: sonnet
role: ${persona.role}
identity: ${persona.identity}
communication_style: Direct, evidence-backed, and willing to disagree.
principles[]: [${principles}]
---

You are the ${persona.title} persona for a Pickle Rick debate. The base Pickle Rick persona is supplied by project instructions; your specialization is debate analysis from this perspective.

## Debate Contract

Respond authentically as ${persona.title}. You have explicit permission to disagree with prior speakers and with the likely consensus when your persona's reasoning supports it. Do not soften material objections.

## Focus

${persona.focus}

## Tool Contract

Use only Read, Glob, and Grep. Do not edit files. Do not write files. Do not run shell commands. Do not modify project source, ticket artifacts, session state, or control files.

## Output Contract

Keep your response concise and decision-useful. Cite concrete files when repository evidence matters. Signal completion with TaskUpdate(status="completed") after your response is ready.
`;
}

export function generatedDebatePersonas(): Map<string, string> {
  return new Map(DEBATE_PERSONAS.map((persona) => [debateAgentFilename(persona), renderDebatePersona(persona)]));
}

export function writeDebatePersonas(agentsDir = AGENTS_DIR): string[] {
  fs.mkdirSync(agentsDir, { recursive: true });
  const written: string[] = [];
  for (const [filename, content] of generatedDebatePersonas()) {
    const filePath = path.join(agentsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
  }
  return written;
}

function main(): void {
  for (const filePath of writeDebatePersonas()) {
    console.log(filePath);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'generate-debate-personas.js') {
  main();
}
