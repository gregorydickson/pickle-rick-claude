// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DotBuilder } from '../services/dot-builder.js';

function baseSpec(overrides = {}) {
  return {
    slug: 'build-helper-test',
    goal: 'exercise build helper validators',
    phases: [],
    acceptanceCriteria: {},
    ...overrides,
  };
}

function phase(name, overrides = {}) {
  return {
    name,
    prompt: `implement ${name}`,
    allowedPaths: ['src/'],
    timeout: '30m',
    ...overrides,
  };
}

function convergenceSpec(overrides = {}) {
  return baseSpec({
    phases: [phase('core')],
    convergence: {
      until: 'V_total == 0 && fixed_point && reproducibility',
      impl: { harness: 'claude-code', prompt: 'Implement convergence fixture' },
      ...overrides,
    },
  });
}

describe('DotBuilder build helper validators', () => {
  it('preflight helper returns diagnostics for bad preflight specs', () => {
    const builder = new DotBuilder(baseSpec({
      phases: [phase('start')],
    }));

    const diagnostics = builder._repairAndValidatePreflightSpecs();

    assert.ok(Array.isArray(diagnostics));
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.some(d => d.rule === 'INVALID_STRUCTURE'));
  });

  it('preflight repairs the builder copy of the spec, never the caller-owned phase and workspace objects', () => {
    const gated = phase('gated', { goalGate: true, allowedPaths: undefined });
    const workspaceOpts = { repoUrl: 'git@github.com:org/repo.git' };
    const builder = new DotBuilder(baseSpec({ phases: [gated], acceptanceCriteria: { gated_ok: 'true' } }));
    builder.workspace(workspaceOpts);

    const diagnostics = builder._repairAndValidatePreflightSpecs();

    const rules = diagnostics.map(d => d.rule);
    for (const rule of ['DIAMOND_MISSING_EDGES', 'MISSING_ALLOWED_PATHS', 'MISSING_AC_MAPPING', 'WORKSPACE_NO_HTTPS']) {
      assert.ok(rules.includes(rule), `expected a ${rule} repair diagnostic, got ${rules.join(', ')}`);
    }
    assert.equal(builder._phases[0].retryTarget, 'fix_gated');
    assert.deepEqual(builder._phases[0].allowedPaths, ['src/**', 'tests/**']);
    assert.equal(builder._phases[0].contextOnSuccess.gated_ok, 'true');
    assert.equal(builder._spec.workspaceOpts.repoUrl, 'https://github.com/org/repo.git');
    assert.equal(gated.retryTarget, undefined);
    assert.equal(gated.allowedPaths, undefined);
    assert.equal(gated.contextOnSuccess, undefined);
    assert.equal(workspaceOpts.repoUrl, 'git@github.com:org/repo.git');
  });

  it('convergence helper returns DUPLICATE_MODEL for duplicate model diversity', () => {
    const builder = DotBuilder.fromSpec(convergenceSpec({
      fixBackend: { model: 'shared-model', harness: 'claude-code', prompt: 'fix backend' },
      reviewers: {
        be: { model: 'shared-model', harness: 'claude-code', prompt: 'review backend' },
      },
    }));

    const diagnostics = builder._validateConvergenceSpec();

    assert.ok(diagnostics.some(d => d.rule === 'DUPLICATE_MODEL'));
  });

  it('structural helper returns diagnostics after DOT emission', () => {
    const builder = new DotBuilder(baseSpec({
      phases: [phase('security_audit', { securityScan: true })],
    }));

    builder._emitDot();
    const diagnostics = builder._runStructuralRules();

    assert.ok(diagnostics.some(d => d.rule === 'REVIEW_MISSING_READONLY'));
  });
});
