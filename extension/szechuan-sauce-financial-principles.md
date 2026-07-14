# Szechuan Sauce: Financial Domain Principles

Supplemental principles for financial/mortgage domain code. Loaded via `--domain financial`. These extend (and where noted, override) the base principles.

<!-- BEGIN FOM_HONEST_REPORTING_RULES -->
## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.
<!-- END FOM_HONEST_REPORTING_RULES -->

## Quick Diagnostic Guide

| Symptom | Principle | Quick Fix |
|---------|-----------|-----------|
| Floating-point currency math | Monetary Precision | Use integer cents or Decimal type |
| Inconsistent rounding across calcs | Rounding Consistency | Centralize rounding strategy |
| API returns `0.1` for money | Currency Display | Always format to 2 decimal places |
| `Math.round(rate * 100) / 100` | Monetary Precision | Use dedicated rounding util |
| Sample vs population confusion | Statistical Correctness | Use N-1 (sample) unless population is known |
| Hardcoded tax/rate constants | Regulatory Compliance | Extract to config, cite regulation |
| Date math with plain strings | Temporal Precision | Use date-fns/luxon, handle business days |
| Missing audit trail on calc | Audit Trail | Log inputs, formula, result |

## Priority Matrix (Financial)

Financial domain violations are elevated one priority level above their base equivalent:
- Base P1 (bugs) → **P0** when involving money or rates
- Base P2 (maintainability) → **P1** when affecting calculation correctness
- Base P3 (polish) → **P2** when affecting financial display

## Principles

### Monetary Precision
All monetary calculations must use consistent, explicit precision. Never use floating-point arithmetic for currency. Use integer cents, `Decimal` types, or libraries like `dinero.js` / `big.js`.

**Violations**: `price * quantity` with floats, `Math.round` for currency rounding, mixing precision strategies in one codebase, storing money as `float`/`double` in the database.

### Rounding Consistency
A single rounding strategy must be defined and applied uniformly. Document which rounding mode is used (banker's rounding, half-up, truncation) and why. All monetary calculations must use the same rounding function.

**Violations**: Multiple rounding approaches in the same codebase, rounding at intermediate steps (round only at final output), undocumented rounding mode choice.

### Currency Display
API responses and UI rendering involving currency must display exactly 2 decimal places (or the locale-appropriate precision). Never return raw floating-point representations to consumers.

**Violations**: API returning `100.1` instead of `100.10`, UI showing `$5.5`, inconsistent decimal places across endpoints.

### Statistical Correctness
Statistical formulas must use sample standard deviation (N-1 denominator) unless the full population is known and documented. Document the statistical method, sample size assumptions, and confidence intervals.

**Violations**: Using population formula (N) on sample data, missing documentation of which formula variant is used, no sample size validation, statistical calculations without confidence bounds.

### Rate and Percentage Handling
Interest rates, APR, discount rates, and other percentages must be stored and transmitted in a consistent format (basis points, decimal, or percentage — pick one per system). Conversions must be explicit and centralized.

**Violations**: Mixing `0.05` and `5.0` representations for 5%, rate conversion logic duplicated across files, ambiguous variable names (`rate` — is it 0.05 or 5?).

### Regulatory Compliance
Financial calculations governed by regulation (TILA, RESPA, Dodd-Frank, TRID) must cite the applicable rule in code comments. Hardcoded regulatory values (thresholds, limits, rates) must be extracted to named constants with regulatory citations.

**Violations**: Magic numbers that are actually regulatory thresholds, calculation logic without regulatory citation, hardcoded compliance dates.

### Temporal Precision
Date calculations involving financial instruments must account for business days, settlement periods, and day-count conventions (30/360, ACT/365, etc.). Use established date libraries — never hand-roll date math.

**Violations**: Using calendar days where business days are required, ignoring day-count conventions, string-based date arithmetic, timezone-naive date comparisons for financial deadlines.

### Audit Trail
All financial calculations must be auditable: log the inputs, formula applied, intermediate results (if meaningful), and final output. Calculation changes must be traceable to a specific code version.

**Violations**: Financial calculation with no logging, calculation result stored without recording inputs, no way to reproduce a historical calculation result.

## Anti-Pattern Quick Reference (Financial)

| Anti-Pattern | Principle Violated | Fix |
|--------------|-------------------|-----|
| `amount * 1.05` (float rate) | Monetary Precision | Use Decimal/cents |
| `toFixed(2)` as rounding | Rounding Consistency | Use explicit rounding util |
| Mixed basis-point/percentage | Rate Handling | Standardize, centralize conversion |
| `new Date() - new Date()` | Temporal Precision | Use date library with business day support |
| Unlabeled `0.035` constant | Regulatory Compliance | Named constant with regulation cite |
| `mean / count` without N-1 | Statistical Correctness | Use sample std dev |
| Calc result with no log | Audit Trail | Add structured audit log |
