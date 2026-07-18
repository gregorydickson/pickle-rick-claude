---
id: many-terms
title: "Synthetic: audit deriveCodegraphTerms, buildCodegraphContextSection, resolveCodegraphIdentifierTerm callers"
status: "Todo"
priority: High
complexity_tier: medium
order: 1
working_dir: /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
source_prd: prds/synthetic.md
source_section: "synthetic"
mapped_requirements: []
created: 2026-07-17
updated: "2026-07-17"
---
# Description

## Problem
Cross-reference every caller of `deriveCodegraphTerms`, `buildCodegraphContextSection`,
`resolveCodegraphIdentifierTerm`, `stripCodegraphCallExpressionNoise`, `isCodegraphTermNoise`,
`createResolverCache`, `computeOneHop`, `normalizeTicketStatus`, `normalizeTicketComplexityTier`,
`getTicketTierBudgetWithOverrides`, `tierUsesGraphContext`, and `readAllowedPathsFile`, since all
twelve are candidates for the many-term resolution pass this fixture exercises.

## Solution
For each of `deriveCodegraphTerms`, `buildCodegraphContextSection`,
`resolveCodegraphIdentifierTerm`, `stripCodegraphCallExpressionNoise`, `isCodegraphTermNoise`,
`createResolverCache`, `computeOneHop`, `normalizeTicketStatus`, `normalizeTicketComplexityTier`,
`getTicketTierBudgetWithOverrides`, `tierUsesGraphContext`, and `readAllowedPathsFile`, confirm the
call sites still compile and re-run `deriveCodegraphTerms` again to double the mention count of
`deriveCodegraphTerms`, `createResolverCache`, and `computeOneHop` so the shared cache sees repeat
lookups against files it already read.

## Acceptance Criteria
- [ ] Every symbol above (`deriveCodegraphTerms`, `buildCodegraphContextSection`,
  `resolveCodegraphIdentifierTerm`, `stripCodegraphCallExpressionNoise`, `isCodegraphTermNoise`,
  `createResolverCache`, `computeOneHop`, `normalizeTicketStatus`, `normalizeTicketComplexityTier`,
  `getTicketTierBudgetWithOverrides`, `tierUsesGraphContext`, `readAllowedPathsFile`) resolves —
  Verify: `echo noop` — Type: manual
