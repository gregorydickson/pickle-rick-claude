> **⏸️ operator-deferred 2026-08-25.** Composed into [[B-CGSHIP]] as ticket `f2b3cf76` / AC-B4, but
> pickle hit its iteration cap with this ticket still pending and it was **never built** — zero commits,
> no code in the tree. Operator ruled it explicitly not high priority and deferred it.
>
> **Not drainable** by the mechanical selection rules while this banner stands. Re-queue only on operator
> request. The mechanism is unchanged and still live: `displayMacNotification`
> (`services/pickle-utils.ts:2877`) shells out via `spawnSyncFn('osascript', ...)` at `:2896`, and the
> open question remains that `spawnSync` returning without throwing is NOT evidence of delivery.

# BUG-2026-08-23 — macOS notifications never arrive

- **Priority**: P2 (operator-facing; the pipeline runs unattended and cannot tell the operator anything)
- **Status**: Open. Operator-raised 2026-08-23 ("completely broken"). Evidence gathered read-only.
- **Sequence**: operator-set — drain AFTER the codegraph FEAT (SEQUENCE item 3).
- **Type**: bug

**Sequence:** operator-set — AFTER the codegraph FEAT (SEQUENCE item 3). Not drainable before it.

## Measured at HEAD (read-only; no repo edits, pipeline was mid-run)

Implementation: `displayMacNotification` (`extension/src/services/pickle-utils.ts:2881`),
shells `osascript -e 'display notification ...'`.

Callers (3): `bin/pipeline-runner.ts:3703` · `bin/microverse-runner.ts:1491` · `bin/mux-runner.ts:10550`.

## Why it can be "completely broken" and nobody finds out

Two independent silent-degrades stacked on the same call:

1. **The code swallows every failure by design.** `catch { /* best-effort: ENOENT / timeout /
   non-zero exit are all non-fatal */ }` — no log, no activity event, no counter.
2. **macOS returns success even when it displays nothing.** Measured on this host:
   `osascript -e 'display notification ...'` → **exit 0**. Exit 0 proves the AppleScript RAN.
   It does NOT prove a banner appeared. If the posting app's alert style is None, or a Focus
   mode is active, macOS accepts the event and shows nothing, still exit 0.

So the observable ("did the operator see it?") is not connected to any signal the system records.
This is the codebase's dominant defect class in its purest form: a failed operation read as a
measured result.

## The identity problem (likely root cause, NOT yet confirmed)

`osascript` does not post as Pickle Rick. Measured: the Notification Center DB
(`$(getconf DARWIN_USER_DIR)com.apple.notificationcenter/db2/db`, table `app`) registers
**`com.apple.scripteditor2`** — Script Editor. Every Pickle Rick notification is delivered under
Script Editor's identity and permission grant. If Script Editor's alert style is None (a common
default for an app the user never opens), 100% of notifications are dropped, silently, forever.

Not confirmed: could not read the alert-style flags — this macOS version's schema has no
`app_info` table, and `~/Library/DoNotDisturb/DB/Assertions.json` is TCC-protected
(`Operation not permitted`), so a Focus mode cannot be ruled out from the shell either.

## The reason five passes failed

The function's own comment records: *"Four prior 'improve notification' passes (8db2771, 2f19356,
f9f37ef, 2da7fe5, 8cc31a6) added features and fixed content but none passed a `timeout`"* — that
is FIVE shas, and the note is about the timeout only. None of them established whether a
notification is ever DELIVERED. They fixed content and features on a channel nobody had verified
carries anything.

**Anatomy-park iteration 4 (this session, in flight) just added the missing `timeout` to this
function** — fixing the hang hazard, which does not make notifications appear.

## Binding AC for whoever builds this

- **AC-1 Prove DELIVERY, not exit code.** An acceptance test asserting `osascript` returned 0 is
  exactly the test that let five passes ship. Delivery must be observed (Notification Center
  `delivered`/`displayed` table row, or a `terminal-notifier`-class sender that reports it).
- **AC-2 Post under an identity the operator can grant permission to**, not Script Editor's.
- **AC-3 The swallow must become observable** — a skipped/failed notification emits one activity
  event or one stderr line. Best-effort is fine; silent is not (PRIME DIRECTIVE: warn, degrade,
  never halt).
- **AC-4 State the precondition explicitly**: if the fix depends on an operator granting a
  notification permission in System Settings, say so — that is an operator UI action, like the
  Spotlight Privacy list, and a PRD that hides it will read as broken forever.

## Open question for the operator
Did the diagnostic banner ("Pickle Rick / notification probe") fired at 2026-08-23 ~15:5x appear?
- **No** → confirms the silent-drop diagnosis above; AC-2 is the fix.
- **Yes** → notifications work at the OS level and the bug is in WHEN the callers fire (3 call
  sites only: pipeline-runner, microverse-runner, mux-runner) — a different bundle entirely.
