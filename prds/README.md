# `prds/` — PRDs, Bug Reports & Engineering Ledger

This directory holds every PRD, bug report, design note, and the engineering ledger for
Pickle Rick. It was reorganized 2026-06-20: ~226 historical docs moved into `archive/`,
leaving the live ledger + actively-referenced docs at the top level.

> Generated DOT/PRD artifacts are **not** committed here (see repo `CLAUDE.md`). Session
> logs under `*/.pickle-rick/sessions/` are gitignored and are not part of this corpus.

## Start here

| Doc | Purpose |
|---|---|
| [`MASTER_PLAN.md`](MASTER_PLAN.md) | **Live ledger** — current version, the drain queue, open findings. Re-read each babysitter tick; kept lean on purpose. |
| [`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) | Shipped releases + closed-finding forensic detail offloaded from the live ledger. |
| [`BUG-INDEX.md`](BUG-INDEX.md) | **Findings catalog** — every `R-*` / `B-*` code → the doc(s) that file/fix it, plus bug-reports chronological and bundles by priority. |
| [`CLAUDE.md`](CLAUDE.md) | PRD authoring guide — Simplification Review, forward-ref grammar, skip-flag conventions. |
| [`babysitter.md`](babysitter.md) | Babysitter drain runbook. |

## Layout

```
prds/
├── MASTER_PLAN.md            live ledger (lean)
├── MASTER_PLAN-archive.md    shipped/closed history
├── BUG-INDEX.md              findings catalog (244 codes)
├── README.md                 this file
├── CLAUDE.md                 authoring guide
├── babysitter.md             drain runbook
├── <pinned docs>             docs referenced by the test suite / src — must keep these paths stable
├── archive/
│   ├── bug-reports/          BUG-REPORT-*.md single-incident write-ups        (98)
│   ├── bundles/              p1/p2/p3 multi-ticket fix bundles                (80)
│   ├── features/             feature / capability PRDs (backends, codegraph…) (25)
│   ├── design-notes/         DESIGN-NOTE / DESIGN-SPIKE / design analyses      (5)
│   ├── subsystem/            per-subsystem CLAUDE.md hardening PRDs            (5)
│   ├── research/             research spikes & CLI-surface findings           (10)
│   ├── incidents/            post-mortem RCAs                                  (3)
│   └── misc/                 uncategorized historical PRDs
└── fixtures/                 test fixtures — load-bearing, do not move
```

## Conventions

- **Naming.** Bug bundles: `p{1,2,3}-bug-fix-bundle-<slug>.md`. Incident reports:
  `BUG-REPORT-YYYY-MM-DD-<slug>.md`. Design analysis: `DESIGN-NOTE-…` / `DESIGN-SPIKE-…`.
- **Pinned docs stay at root.** Some docs are read by tests (`doc-cross-reference.test.js`,
  the citadel parser, etc.) or `src/`. They keep their `prds/<name>.md` path even though
  they're historical — moving them reddens the gate. Don't relocate a doc without first
  grepping `extension/{src,tests}` for its basename.
- **Archiving ≠ deleting.** Everything is retained for bug-history analysis. New PRDs land
  at the top level (or the right `archive/` bucket if authored as historical reference);
  the live worklist is `MASTER_PLAN.md`, not the directory layout.
- **Finding a bug's history:** search `BUG-INDEX.md` for the `R-*`/`B-*` code → open the
  listed doc → confirm shipped/closed disposition in `MASTER_PLAN-archive.md` or `git log`.
