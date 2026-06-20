---
title: P2 bug-fix bundle — B-LASP — log-activity.js schema-resolution deploy-parity
status: Draft
filed: 2026-06-01
priority: P3
type: bug-bundle
code: B-LASP
composes:
  - "#87 R-LASP — deployed bin/log-activity.js resolves the activity schema via a src/types/ path install.sh never creates → ENOENT, fail-open"
backend_constraint: any
schema_neutral: true   # tooling fix; no state.json field, no LATEST_SCHEMA_VERSION change, no new event
source:
  - prds/MASTER_PLAN.md   # Open Finding #87 R-LASP
---

# B-LASP — log-activity.js schema-resolution deploy-parity

> **Tooling fix, schema-neutral.** No state.json field, no new event, no command/flag. One TS source file (`extension/src/bin/log-activity.ts`) + one deploy-parity test + `bash install.sh` (closer). PATCH bump.

## Trigger

MASTER_PLAN drain-queue row 11b (`#87 R-LASP`). The deployed activity-logger CLI emits, on **every** invocation:

```
Failed to load activity schema: ENOENT: no such file or directory, open
'/Users/<user>/.claude/pickle-rick/extension/src/types/activity-events.schema.json'
```

It then **fail-opens** (skips JSON-schema validation of the activity event and logs anyway). Surfaced after the v1.86.0 install (2026-05-30); reproduced again 2026-06-01.

## Root cause

`extension/src/bin/log-activity.ts:44` resolves the schema relative to the **compiled** bin location:

```ts
const raw = fs.readFileSync(new URL('../src/types/activity-events.schema.json', import.meta.url), 'utf8');
```

- **In-repo** (`extension/bin/log-activity.js`): `../src/types/…` → `extension/src/types/activity-events.schema.json` — **exists**, so validation works.
- **Deployed** (`~/.claude/pickle-rick/extension/bin/log-activity.js`): `../src/types/…` → `~/.claude/pickle-rick/extension/src/types/activity-events.schema.json` — **does NOT exist**. `install.sh` does not deploy the `src/` tree; the schema is deployed to the **extension root** (`~/.claude/pickle-rick/extension/activity-events.schema.json`, confirmed present).

So the single literal path is correct in-repo and wrong when deployed. The CLI degrades fail-open (validation silently skipped). Pipelines are unaffected (runtime logging uses the compiled `state-manager.js`, not this CLI), so this is **P3 tooling** — but every babysitter/operator `log-activity.js` call spams the ENOENT and runs unvalidated.

## In scope

- Make `log-activity.ts` resolve the schema with a **deploy-target-first, in-repo-fallback** strategy: attempt the deployed layout (extension-root, i.e. `../activity-events.schema.json` relative to the compiled bin) first, fall back to the in-repo `../src/types/activity-events.schema.json`. Both the deployed and in-repo invocations must load the schema and validate.
- A **deploy-parity test** that asserts the schema is reachable from the compiled-bin location under the deployed layout (so this regression cannot silently return).
- Closer: gate, PATCH bump, `install.sh` deploy, push, release, MASTER_PLAN repoint closing #87.

## Not in scope

- Changing `install.sh`'s schema deploy target (the extension-root location is fine — the fix aligns the resolver to it; do not move the deployed schema).
- Any change to runtime activity logging in `state-manager.ts` (already correct — does not use this CLI's resolver).
- Adding new activity events or schema fields (schema-neutral).

## Atomic tickets

### R-LASP-1 (small) — Deploy-target-first schema resolution + in-repo fallback
- **Scope:** edit only `extension/src/bin/log-activity.ts`. Replace the single `new URL('../src/types/activity-events.schema.json', import.meta.url)` read with an ordered-candidate resolver: try the deployed layout first (`../activity-events.schema.json` relative to the compiled bin = the install.sh extension-root target), then the in-repo `../src/types/activity-events.schema.json`. Read the first candidate that exists; only warn if **all** candidates fail. Preserve the existing fail-open behavior on total miss (warn + skip validation, never throw).
- **AC-LASP-1-1:** running the **deployed** CLI (`node ~/.claude/pickle-rick/extension/bin/log-activity.js review "probe"`) emits **no** `Failed to load activity schema` line (`2>&1 | grep -c "Failed to load activity schema"` returns `0`) after deploy.
- **AC-LASP-1-2:** `grep -c "src/types/activity-events.schema.json" extension/src/bin/log-activity.ts` ≥ 1 **and** `grep -c "activity-events.schema.json" extension/src/bin/log-activity.ts` ≥ 2 (both the deploy-target and in-repo candidates are present in source).
- **AC-LASP-1-3:** the resolver never throws on a missing schema — total-miss path warns and continues (fail-open preserved); covered by AC-LASP-2-1's test asserting graceful degradation when no candidate exists.

### R-LASP-2 (small) — Deploy-parity regression test
- **Scope:** add a test (e.g. `extension/tests/log-activity-schema-deploy-parity.test.js`) (forward-created) that (a) asserts the resolver finds the schema when the schema sits at the extension-root (deployed layout) and the `src/types/` path is absent, (b) asserts it finds the in-repo `src/types/` schema when extension-root is absent, and (c) asserts graceful fail-open (no throw, warn emitted) when neither exists.
- **AC-LASP-2-1:** the new test file exists and passes in the fast tier (`node --test` green); it exercises all three cases (deployed-layout hit, in-repo-layout hit, total-miss fail-open).
- **AC-LASP-2-2:** `npm run test:fast` stays green with the new test included.

### C-LASP-CLOSER [manager] — Ship B-LASP
- **Scope:** run the FULL release gate from `extension/`, **PATCH** bump (`1.90.0 → 1.90.1`; tooling fix, schema-neutral — no new command/flag/event/state field), `bash install.sh` to deploy the corrected `log-activity.js`, push, `gh release create`, repoint MASTER_PLAN (close #87).
- **AC-CLOSER-1:** Full release gate GREEN from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` all exit 0. READ the gate result and confirm green before bump/commit/tag.
- **AC-CLOSER-2:** `extension/package.json:version` = `1.90.1`; commit subject `chore(C-LASP-CLOSER): ship B-LASP — bump 1.90.1 + close #87`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; deployed CLI loads the schema (`node ~/.claude/pickle-rick/extension/bin/log-activity.js review "deploy-probe" 2>&1 | grep -c "Failed to load activity schema"` returns `0`); `git status` clean at tag time.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create v1.90.1` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-LASP SHIPPED and closes #87. Verify: `grep -c "B-LASP.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- The deployed `log-activity.js` loads + validates against the activity schema with no ENOENT; the in-repo invocation still works; a deploy-parity test locks both layouts + the fail-open path.
- Release gate green, clean tree, PATCH bump, shipped via `gh release create`, MASTER_PLAN repointed, #87 closed.

— Pickle Rick out. *belch*
