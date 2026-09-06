# B-CLIBRITTLE — an external CLI upgrade silently disabled a phase, and nothing in the system could see it

---
title: "B-CLIBRITTLE — every phase spawns the ambient `claude` CLI, inherits its config validation, and records nothing about it"
status: draft
priority: P1
type: bug-bundle
composes: [szechuan-baseline-unmeasurable, cli-version-observability, spawn-startup-failfast, ambient-config-coupling]
---

> **RESCOPED 2026-09-05.** This PRD was filed as "the judge times out at its own raised ceiling" on the
> theory that `R-SJWT`'s 600s budget had been consumed by repo growth. **That premise is FALSIFIED** —
> see below. The real defect is not cost, and not the judge.

## Trigger — szechuan worked for months, then stopped, and we changed nothing

| when | what |
|---|---|
| 2026-09-01 08:56 CDT | szechuan **completed successfully** — CLI `2.1.252` |
| **2026-09-04 12:57 CDT** | **`claude` CLI auto-updated `2.1.252` → `2.1.260`** (`~/.claude/.last-update-result.json`) |
| 2026-09-05 00:17 CDT | szechuan **FAILED** — `judge timed out after 600s`, 4 attempts |
| 2026-09-05 09:27 CDT | szechuan **FAILED** — `Permission allow rule … Write(.claude/commands/**) is not matched by file permission checks` |

Every szechuan run before that timestamp succeeded; every one after it failed. **Nothing in this repo
changed across the boundary.**

**The cost theory is dead, measured not argued.** The judge's scored surface went `600 → 607 → 611 →
612` allowed_paths across the whole period, same `base_sha 578cbf96`. A 2% scope change cannot take a
working judge to a 600s timeout. `extension/src` grew 4.8% in bytes over the same window — also
insufficient. **Do not scope a cost-reduction bundle.**

**The permission rule proves the mechanism.** `Write(.claude/commands/**)` entered
`.claude/settings.local.json` on **2026-04-17** and was benign for five months, present in both the
last-good and first-bad trees. `2.1.260` began rejecting it, and that rejection killed the judge
subprocess. The failure is CLI-side config validation reaching into a phase.

## Root — the design couples every phase to an ambient, self-updating binary, and observes nothing about it

1. **No version observability.** `codex_version_seen` exists in `State` (`types/index.ts:120`), but
   **`claude_version` / `cli_version` appears NOWHERE in `src/`.** We instrument the backend we rarely
   use and not the one every spawn depends on. Four sessions of state carry no evidence of the change
   that broke them — which is why diagnosing this took a four-session bisect instead of one log line.
2. **No fast-fail.** A startup rejection burned the full budget **four times** (~40 min) before
   reporting. A config the CLI refuses is knowable in milliseconds.
3. **Undifferentiated disposition.** A config rejection and a genuinely slow judge both land on
   `baseline_unmeasurable_unrecoverable` — the `failed`-vs-`empty` collapse, which is exactly why two
   unrelated failures read as one recurring defect for two ticks.
4. **Ambient config coupling.** The judge inherits `.claude/settings.local.json`; a rule the CLI later
   dislikes takes down a phase. Phase-critical spawns should not inherit operator-editable ambient
   config they do not need.
5. **Blast radius is not the judge.** Three invocation builders return `cmd: 'claude'`, and workers,
   managers, remediators and judges all spawn it. The judge is where this surfaced first, not where it
   is confined. **Any CLI change can break any of them, and today each would be diagnosed separately.**

## Acceptance criteria (machine-checkable)

- **AC-1** The resolved `claude` CLI version is recorded in session state at setup and is present in the
  activity log at every backend spawn resolution. A future external break is visible in the FIRST log,
  not after a bisect. Negative control: an unresolvable version records `null` and does not halt.
- **AC-2** A backend spawn that fails at STARTUP (non-zero, or a recognisable config/permission
  rejection, before any usable output) is detected as such and does NOT consume the full timeout, and
  does NOT consume all retry attempts. State the measured before/after wall-clock.
- **AC-3** A startup/config failure is DISTINGUISHABLE in state and logs from a measurement that ran and
  timed out. `baseline_unmeasurable_unrecoverable` must no longer be the single bucket for both.
  Negative control: a genuine slow-judge timeout still reports as a timeout.
- **AC-4** Decide, by measurement, whether phase-critical spawns need ambient `.claude/settings*.json`
  at all. If not, stop inheriting it — that is the subtraction and it removes the coupling class rather
  than guarding one instance. If they do, name exactly what they need and why.
- **AC-5** Census EVERY `claude` spawn site and state the count. Each is either covered by AC-2/AC-3 or
  recorded as inert with the reason that bounds it. "The judge was the one that broke" is not a bound.
- **AC-6** szechuan measures a real baseline on this repo — demonstrated by a live phase run reaching
  iteration 1 with a scored baseline, not by a unit test.
- **AC-7** Closer: full release gate green with the soak genuinely RUN (`PICKLE_INSTALL_ROOT` off
  `$HOME`), plus a `ci-repro.sh --runner-release 24.04` run naming the sha.

## Explicit non-goals

- Do NOT raise `timeout_seconds`. The cost theory is falsified; a bigger number fixes nothing here.
- Do NOT pin or downgrade the CLI as the fix. Pinning hides the coupling instead of removing it, and the
  next upgrade is not optional forever. (Pinning is a legitimate *diagnostic*, not a deliverable.)
- Do NOT re-derive the timeline. It is measured above.

## Ticket classes

1. AC-1 version observability at setup + spawn resolution.
2. AC-2 + AC-3 startup-failure detection and disposition split.
3. AC-4 ambient-config coupling: measure, then subtract.
4. AC-5 spawn-site census across all builders.
5. Closer: gate + genuinely-run soak + ci-repro evidence.
