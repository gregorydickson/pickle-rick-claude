# Szechuan Sauce: UI Domain Principles
<!-- (forward-created) by ticket f56e8ddb -->

Supplemental principles for UI/frontend code in design-safe mode. Auto-loaded when `design_safe` is active. These extend the base principles with UI-specific guidance that protects deliberate visual decisions as author intent.

<!-- BEGIN FOM_HONEST_REPORTING_RULES -->
## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.
<!-- END FOM_HONEST_REPORTING_RULES -->

## Quick Diagnostic Guide

| Symptom | Principle | Correct Response |
|---------|-----------|-----------------|
| `margin: 37px` flagged as magic number | Author Intent | It's intentional — skip |
| Two cards with different padding | Author Intent | They're visually distinct — skip |
| `color: #ff6b35` not in a variable | Author Intent | Brand color in place — skip |
| Identical-looking components merged | Component Uniqueness | Revert — visual similarity ≠ duplication |
| JSX reformatted for "consistency" | Markup Structure | Revert — formatting encodes layout intent |
| Spacing normalized to nearest 4px | Magic Numbers | Revert — exact value is the design |

## Priority Matrix (UI)

Visual-decision violations are NOT elevated — they are **false positives**. The base principles apply to logic, structure, and correctness only.

- P0–P4 severity levels apply only to logic correctness, accessibility errors, and semantic bugs
- UI spacing, color, and layout values are **not flagged** regardless of priority level
- Component-shape choices are **not flagged** as DRY violations
- JSX/markup formatting differences are **not flagged** as inconsistencies

## Principles

### Author Intent

Deliberate visual decisions are expressions of design intent, not coding violations. Any spacing, sizing, color, or layout value that a designer or developer chose is correct by definition — it encodes a visual decision that cannot be recovered once lost to normalization.

**False positive** (do NOT flag): `margin: 37px`, `padding: 11px 15px`, `border-radius: 6px`, hex colors, RGBA values, `z-index: 1003`, `line-height: 1.45`, pixel values that don't align to a grid system.

**True positive** (DO flag): computed values that produce wrong output, arithmetic errors in layout math, conflicting values that make a component invisible or broken.

### Magic-Number Spacing and Colors

Magic numbers in UI code are not magic — they are precise. Pixel values, opacity levels, and color codes represent specific visual outcomes arrived at through design iteration. Normalizing them (rounding to nearest 4px, extracting to a shared constant, aligning to a grid) changes the visual output and destroys the design decision.

**False positive** (do NOT flag): any numeric literal in a CSS property, style object, or class definition — `gap: 14`, `width: 233`, `opacity: 0.87`, `#3d5a80`, `rgba(0,0,0,0.54)`.

**True positive** (DO flag): the same computed value duplicated in three or more logically identical places (e.g. the same button's hover color defined twice with different values — that's a bug, not a style choice).

### Component Uniqueness

Visually distinct components must not be merged or abstracted, even when they look similar in code. Two components that render differently for the user serve different purposes. The DRY Rule of Three does not apply to visually-distinct UI components — incidental structural similarity is not duplication.

**False positive** (do NOT flag): two card components with similar prop shapes but different visual treatment; two button variants that share a base style but differ in size, color, or spacing; two list items that look similar but are semantically different.

**True positive** (DO flag): the exact same component copy-pasted with no intentional difference and no path to diverge (pure duplication with identical props, identical rendering, no design distinction).

### Markup Structure

JSX structure, HTML nesting, and template layout encode visual hierarchy, accessibility semantics, and design intent. Reformatting markup for "code consistency" — flattening nesting, reordering sibling elements, changing whitespace patterns, extracting inline fragments — changes the rendered output or breaks accessibility.

**False positive** (do NOT flag): any JSX/markup formatting that differs from surrounding code style; deeply nested elements; inline conditional rendering; fragments used for layout reasons; whitespace-sensitive text nodes.

**True positive** (DO flag): markup that produces a broken layout due to structural errors; elements nested in semantically incorrect parents (e.g. `div` inside `p`); accessibility attribute errors.

## False Positives — Do NOT Flag

In design-safe mode, the following are **never violations** regardless of base-principle scores:

- Any numeric literal in a CSS-in-JS style object, Tailwind class, or inline style attribute
- Color values (hex, RGB, HSL, named) anywhere in the codebase
- Component files whose visual output differs from a sibling component, even if their code structure is similar
- JSX/HTML formatting that differs from surrounding code conventions
- Spacing constants that appear to be "magic numbers" but are in use only once
- Values that don't conform to a design-token system — the design token system may not exist yet, and introducing it is out of scope for deslopping
- Any change that would alter pixel-perfect rendering output

These are categorically not violations in UI code. Drop them before scoring. Do not assign any confidence score to them.
