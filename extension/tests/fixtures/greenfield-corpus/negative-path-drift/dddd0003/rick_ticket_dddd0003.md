---
id: dddd0003
key: NEG-PATH
ac_ids: []
---

# Negative — real path-drift, NO annotation

This ticket cites a backticked path that does NOT exist in `git ls-files` and is NOT
forward-create-declared or annotated. The ticket-audit gate MUST emit a fatal
`path-drift` finding (exit 1).

## Files

- `extension/src/services/this-path-does-not-exist-greenfield-negative.ts`

## Acceptance Criteria

- [ ] File exists at HEAD.

<!-- audit: 7-class checked 2026-06-13 -->
