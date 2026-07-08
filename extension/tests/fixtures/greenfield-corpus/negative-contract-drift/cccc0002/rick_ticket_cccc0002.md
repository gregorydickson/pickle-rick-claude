---
id: cccc0002
key: NEG-CONTRACT
ac_ids: []
---

# Negative — unresolved contract ref, NO annotation

This ticket cites an in-repo symbol contract that does NOT resolve at HEAD and carries
NO forward-create annotation. Readiness MUST flag it as a `contract` finding and fail.

## Interface Contracts

- `PhantomGreenfieldNegativeSymbol.resolveNothing()` MUST exist.

## Acceptance Criteria

- [ ] `node --test` passes.
