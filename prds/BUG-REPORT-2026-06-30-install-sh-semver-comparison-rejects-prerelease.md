# BUG REPORT — install.sh `compare_semver` rejects prerelease versions → downgrade guard dead for the whole `beta.*` line

**Filed:** 2026-06-30 (surfaced during the beta.31 closer deploy)
**Code:** R-ISVP (install semver prerelease)
**Priority:** P3 (currently benign; latent safety-guard gap)
**Component:** `install.sh` (`compare_semver` + the downgrade-refuse callsite)

## Symptom (observed)

During `bash install.sh` for the v2.0.0-beta.31 deploy:

```
❌ Invalid semver comparison: '2.0.0-beta.31' vs '2.0.0-beta.30'
install.sh: line 199: [: : integer expression expected
```

Install then proceeded normally (the only real block that run was the unrelated active-session
REFUSE). So the error is **non-fatal today** — but it is not harmless.

## Root cause (verified, not guessed)

`compare_semver` (install.sh:52) validates its two args with:

```sh
if [[ ! "$a" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || [[ ! "$b" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
  echo "❌ Invalid semver comparison: '$a' vs '$b'" >&2
  exit 1
fi
```

The regex matches **only** plain `X.Y.Z`. Every prerelease version (`2.0.0-beta.NN`) fails it, so the
function prints to stderr and `exit 1`s. Because the sole caller invokes it in a command substitution:

```sh
if [ "$(compare_semver "$SRC_V" "$DEP_V")" -lt 0 ]; then   # install.sh:199
```

the `exit 1` terminates only the **subshell**; `$(...)` captures empty stdout (the message went to
stderr), so the test becomes `[ "" -lt 0 ]` → `integer expression expected` → the `if` evaluates false
and the downgrade branch is skipped.

## Impact

- **The downgrade-protection guard is dead for the entire `2.0.0-beta.*` line.** Its job is to
  `REFUSE: source vX older than deployed vY` (install.sh:200-203). Since `compare_semver` can never
  return `-1` for two prerelease versions, an **accidental downgrade deploy** (e.g. checking out
  `beta.20` and running install.sh over a deployed `beta.31`) is **not refused** — it silently
  installs the older runtime. This is the exact class the guard exists to prevent.
- Cosmetic: a scary `❌ Invalid semver comparison` + `integer expression expected` prints on every
  beta→beta deploy, training operators to ignore install.sh stderr.

Not reproduced: a true prerelease-vs-release or cross-major downgrade (the regex rejects those too).

## Fix direction (reuse-first; re-arms an existing guard, no new machinery)

Make `compare_semver` understand an optional prerelease suffix. Minimal correct shape:

1. Widen the validation regex to accept an optional `-<prerelease>`:
   `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`.
2. Compare `X.Y.Z` first (existing logic, unchanged). When the core triplet is equal, compare the
   prerelease per semver: **no-prerelease outranks any prerelease**, and two prereleases compare by
   dot-separated identifiers (numeric identifiers numerically — so `beta.31 > beta.20`). For our
   single `beta.N` scheme, comparing the trailing integer is sufficient and the simplest correct rule.
3. Stop using `exit 1` inside a function consumed by `$(...)` — on genuine garbage input `return` a
   sentinel (or echo a defined value) so the caller's `[ ... -lt 0 ]` never hits
   `integer expression expected`. (The `exit`-in-subshell smell is what made the failure silent.)

## Simplification Review (subtract-before-add)

1. **Necessary?** Yes — but it is a *correctness repair of existing code*, not a new feature. It
   re-arms a guard that is currently dead, rather than adding a new gate.
2. **Reuse vs add?** Reuse: extend the existing `compare_semver` + its single callsite; no parallel
   comparator, no new flag/state. The X.Y.Z path is unchanged.
3. **Guards existing brittle complexity?** It *fixes* the brittle guard (the over-strict regex), it
   does not wrap it. No second escape hatch.
4. **Subtract?** Replace the `exit 1`-in-subshell anti-pattern with a `return`/sentinel — removes a
   silent-failure mode. Net: the comparator becomes correct for the versioning scheme actually in use.

## Acceptance criteria

- `compare_semver 2.0.0-beta.31 2.0.0-beta.30` → `1`; `... beta.30 beta.31` → `-1`; equal → `0`.
- `compare_semver 2.0.0 2.0.0-beta.31` → `1` (release outranks prerelease).
- A `beta.N → beta.(N-1)` install over a deployed newer beta is **refused** (downgrade guard fires)
  absent `--allow-downgrade`.
- No `Invalid semver comparison` / `integer expression expected` on a normal beta→beta upgrade.
- A test under `extension/tests/` covers the prerelease comparison matrix (install-script test suite).
