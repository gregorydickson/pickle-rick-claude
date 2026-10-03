/**
 * ONE rule for which requirement ids a PRD DEFINES, shared by refinement coverage
 * (`spawn-refinement-team.ts`), readiness (`check-readiness.ts`) and citadel (`prd-parser.ts`).
 *
 * Two decisions, each made exactly once and neither a list:
 *
 * 1. DEFINES vs CITES (per id) — a definition has no PROSE WORD before it on its line. Other
 *    requirement ids are not prose, so a multi-id lead (`- **AC-G1**, **AC-G2**:`) defines both,
 *    and every block lead (heading, bullet, checkbox, table row, numbered item, blockquote, bold,
 *    backticks) falls out of that one property.
 * 2. WHICH SPELLING (per PRD) — the generic `<UPPER>-<n>` form (`FR-1`, `REQ-12`) applies only when
 *    the PRD defines no `AC-*` id. No prefix list: a PRD that numbers its requirements any other way
 *    is read in the generic form, and a PRD that defines any `AC-*` keeps the `AC-*` form untouched.
 */
const AC_ID_SOURCE = '\\bAC-[A-Z0-9-]+\\b';
// `(?!AC-)` keeps the two spellings disjoint: generic mode can never yield an AC id.
const GENERIC_ID_SOURCE = '\\b(?!AC-)[A-Z][A-Z0-9]*-\\d+[a-z]?\\b';
const AC_ID_RE = new RegExp(AC_ID_SOURCE, 'g');
const GENERIC_ID_RE = new RegExp(GENERIC_ID_SOURCE, 'g');
/** The ids `line` DEFINES under `idRe`, never the ones it merely cites. */
export function definedRequirementIdsInLine(line, idRe) {
    const re = new RegExp(idRe.source, idRe.flags.includes('g') ? idRe.flags : `${idRe.flags}g`);
    const defined = [];
    for (const match of line.matchAll(re)) {
        if (!/[A-Za-z]/.test(line.slice(0, match.index).replace(re, '')))
            defined.push(match[0]);
    }
    return defined;
}
function definedIdsInPrd(markdown, idRe) {
    const ids = new Set();
    for (const line of markdown.split(/\r?\n/)) {
        for (const id of definedRequirementIdsInLine(line, idRe))
            ids.add(id);
    }
    return [...ids].sort();
}
/** The id pattern this PRD is read with: `AC-*` when it defines any, else the generic form. */
export function requirementIdPatternFor(markdown) {
    return definedIdsInPrd(markdown, AC_ID_RE).length > 0 ? AC_ID_RE : GENERIC_ID_RE;
}
/** Every requirement id the PRD DEFINES, sorted and unique, in the one spelling it uses. */
export function requirementIdsInPrd(markdown) {
    return definedIdsInPrd(markdown, requirementIdPatternFor(markdown));
}
