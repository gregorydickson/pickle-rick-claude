---
id: all-noise
title: "Fix the return const in the while"
status: "Todo"
priority: High
complexity_tier: medium
order: 1
working_dir: /nonexistent
source_prd: prds/synthetic.md
source_section: "synthetic"
mapped_requirements: []
created: 2026-07-17
updated: "2026-07-17"
---
# Description

## Problem
See `extension/src/bin/spawn-morty.ts:584-602` and `:594-595` for the offending span, and
`mux-runner.ts:5758` for the sibling. The bug is near `pipeline-runner.ts:3203-3210` too.
When the worker hits `return` early it should instead `break` out of the `while` loop, but
today it falls through to `else` and the `const` binding never updates, so the `function`
keeps using a stale `true`/`false` pair instead of re-checking `typeof` on the next `for` pass.

## Solution
Whoever picks this up should carefully rewrite the control flow so that the `switch`
statement's `default` case does not `throw`, and the `try`/`catch`/`finally` chain
correctly `delete`s the stale entry before the `async`/`await` boundary, all while keeping
`static`/`readonly` semantics intact across the `import`/`export` surface described in
this extremely long sentence that exists purely to exceed the forty character prose cutoff.

## Acceptance Criteria
- [ ] The `void` return type stays `undefined` on the `case`/`default` fallthrough — Verify: `:1` — Type: manual
