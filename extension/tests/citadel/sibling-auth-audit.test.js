// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';

// Build a minimal NestJS-style controller with two sibling routes under the same
// resource prefix (/orders/:id). One route's body invokes BOTH a budget guard and
// a csrf check; the sibling does neither. This exercises the new guard-token
// detection (budget-check, csrf-validation) added in AC-2 alongside the existing
// flag-check, and proves no duplicate flag-check is emitted.
function writeControllerFixture(repoRoot) {
  const rel = 'src/orders.controller.ts';
  const body = `import { Controller, Get, Post } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.svc.status(id);
  }

  @Post(':id/charge')
  charge(@Param('id') id: string) {
    if (this.featureFlag('billing')) {
      this.assertBudget(id);
      this.verifyCsrf(id);
    }
    return this.svc.charge(id);
  }
}
`;
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, rel), body);
  return rel;
}

function runAudit(repoRoot, rel) {
  return auditSiblingAuthPreconditions({
    range: 'BASE..HEAD',
    base: 'BASE',
    head: 'HEAD',
    repoRoot,
    changedFiles: [{
      path: rel,
      status: 'M',
      kind: 'production',
      changedLines: [{ start: 1, end: 30 }],
      blame: [],
    }],
    claudeFiles: [],
  });
}

describe('sibling-auth-audit: budget-check + csrf-validation token detection (AC-2)', () => {
  test('the charge route surfaces budget-check, csrf-validation, and flag-check tokens with no duplicate flag-check', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-auth-'));
    try {
      const rel = writeControllerFixture(repoRoot);
      const report = runAudit(repoRoot, rel);

      const charge = report.routes.find((r) => r.methodName === 'charge');
      assert.ok(charge, 'charge route must be parsed');

      const tokens = charge.guardPrefix;
      assert.ok(tokens.includes('budget-check'), `expected budget-check in ${JSON.stringify(tokens)}`);
      assert.ok(tokens.includes('csrf-validation'), `expected csrf-validation in ${JSON.stringify(tokens)}`);
      assert.ok(tokens.includes('flag-check'), `expected flag-check in ${JSON.stringify(tokens)}`);

      // No duplicate flag-check emission (guardPrefix is uniqueSorted, but assert explicitly).
      assert.equal(
        tokens.filter((t) => t === 'flag-check').length,
        1,
        'flag-check must appear exactly once',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('guard-parity finding surfaces the new tokens as missing on the bare sibling', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-auth-'));
    try {
      const rel = writeControllerFixture(repoRoot);
      const report = runAudit(repoRoot, rel);

      // The two sibling routes have divergent guard signatures → a parity finding fires.
      const parity = report.guardParityFindings.find((f) => f.resourcePrefix.includes('orders'));
      assert.ok(parity, 'a guard-parity finding must fire for the divergent siblings');
      const missing = parity.missingGuards;
      assert.ok(missing.includes('budget-check'), `budget-check must surface as missing: ${JSON.stringify(missing)}`);
      assert.ok(missing.includes('csrf-validation'), `csrf-validation must surface as missing: ${JSON.stringify(missing)}`);
      // flag-check appears at most once in the aggregated missing-guards set.
      assert.ok(missing.filter((t) => t === 'flag-check').length <= 1, 'no duplicate flag-check in missingGuards');
      // Every finding carries an enum-valid severity.
      const ENUM = new Set(['Critical', 'High', 'Medium', 'Low']);
      assert.ok(ENUM.has(parity.severity), `severity ${parity.severity} must be an enum value`);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('ignores string-literal braces when slicing a method body', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-auth-'));
    try {
      const rel = 'src/orders.controller.ts';
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, rel), [
        'import { Controller, Get } from "@nestjs/common";',
        '',
        '@Controller("orders")',
        'export class OrdersController {',
        '  @Get(":id/detail")',
        '  getDetail(@Param("id") id: string) {',
        '    const marker = "}";',
        '    this.verifyCsrf(id);',
        '    return marker;',
        '  }',
        '',
        '  @Get(":id/summary")',
        '  getSummary(@Param("id") id: string) {',
        '    return this.svc.summary(id);',
        '  }',
        '}',
        '',
      ].join('\n'));

      const report = runAudit(repoRoot, rel);
      const detail = report.routes.find((route) => route.methodName === 'getDetail');
      assert.ok(detail, 'getDetail route must be parsed');
      assert.ok(
        detail.guardPrefix.includes('csrf-validation'),
        `csrf-validation must survive string-literal braces: ${JSON.stringify(detail.guardPrefix)}`,
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
