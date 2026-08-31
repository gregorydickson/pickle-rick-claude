#!/usr/bin/env bash
#
# ci-repro.sh — run this repo's test tier inside a Linux container whose provisioning is
# DERIVED from .github/workflows/*.yml, so that a local failure means the same thing a CI
# failure means.
#
# WHY THIS EXISTS
# ---------------
# A naive `docker run -v "$PWD":/repo:ro node:22 npm run test:fast` reports ~106 failures
# against CI's 2. Measured at fe7860bb, the difference is entirely provisioning, not code.
# Four gaps, each closed below, each with the CI fact that justifies closing it:
#
#   EXTENSION_DIR unset      -> 54 x "Cannot find module .../pickle-rick/extension/bin/..."
#     CI sets EXTENSION_DIR to the checkout (ci.yml), so getExtensionRoot() resolves to the
#     repo instead of the deployed root that CI never creates.
#   bind mount, not checkout -> 14 x "fatal: not a git repository"
#     CI does a real checkout: writable tree, correct ownership, full history.
#   running as root          -> ~18 permission-simulation failures
#     A test that writes a 0444 file to force an error proves nothing when the writer is
#     root, and `/*/*/.claude/...` cannot match a root HOME only one component deep. The
#     GitHub runner is uid 1001 at /home/runner. The workflow itself is the evidence: a
#     job that writes `sudo apt-get` is not running as root.
#   runner-image tools       -> ~20 x "jq: command not found" / "rsync: command not found"
#     ubuntu-latest preinstalls these; node:22 does not. See RUNNER BASELINE below.
#
#   ...and one gap this harness creates for itself, closed the same way:
#   corepack's lazy pnpm     -> ~6 convergence-gate failures
#     `corepack enable` only installs a shim; the first `pnpm` call downloads pnpm from
#     registry.npmjs.org. CI has network and never notices. This harness does not (below),
#     so provisioning materialises pnpm into the image while the network is still up.
#
# A repro harness that is 98% noise cannot falsify anything, so the point of this script is
# the provisioning, not the container.
#
# DERIVED, NOT MIRRORED
# ---------------------
# Every element is read out of the workflow YAML at run time: runner image, node version,
# apt packages, `corepack enable`, EXTENSION_DIR, checkout depth, whether the job is root,
# and the gate command string. A hand-maintained copy of CI's setup steps rots green the
# moment CI changes — it keeps reporting success while reproducing an environment that no
# longer exists. Where a structurally required field cannot be read, this script EXITS
# NON-ZERO naming the field and the file. It refuses to run rather than run something it
# cannot describe.
#
# THE DISTRO IS PART OF THE ANSWER
# --------------------------------
# Package NAMES derive from the workflow; package VERSIONS are a property of the distro, and
# for a while this harness got the second half wrong. It provisioned from `node:<major>` --
# Debian bookworm -- and so installed ripgrep 13.0.0 where CI installs 14.1.0. A2 (e8e71b7a)
# turned out to be a rg-14-only behaviour, so the harness was structurally incapable of
# reproducing the failure it was pointed at, and returned a confident green. While that held,
# a green here was not evidence about ANY version-sensitive tool.
#
# So the base is the runner's own release, with the derived node copied on top:
#   FROM ubuntu:<release>                            <- what `runs-on` resolves to
#   COPY --from=node:<major> /usr/local /usr/local   <- the derived node, unchanged
# node:<major> ships the official nodejs.org build, which is the same artifact
# `actions/setup-node` fetches, so node stays faithful while the userland becomes CI's.
#
# RESOLVING `ubuntu-latest` -- why this is NOT a string transform
# ---------------------------------------------------------------
# `ubuntu-latest` is a GitHub label; `ubuntu:latest` is a Docker Hub tag. They are two
# vendors' opinions about the word "latest", and they DISAGREE today: Docker Hub is already
# Ubuntu 26.04 (ripgrep 15.1.0) while GitHub is still on 24.04 (ripgrep 14.1.0). Rewriting
# one into the other would swap a silent bookworm/rg-13 infidelity for a silent 26.04/rg-15
# one -- and would be trusted MORE, because it looks derived. That was measured, not assumed.
#
# A version-pinned label (`ubuntu-24.04`) is therefore used as written, and `-latest` is
# resolved from the only authority that knows what it currently means: the workflow's own
# most recent run, which prints `Image: ubuntu-<release>` about itself. The resolution follows
# GitHub's next migration with no edit here. If it cannot be read, this script exits 2 naming
# the field and `--runner-release` rather than guessing.
#
# WHAT THE IMAGE ACTUALLY IS -- reported, not asserted
# ----------------------------------------------------
# Derivation states an intention; only the built image states a fact. So `--print-env` and the
# run summary MEASURE the provisioned image -- /etc/os-release, node, and a `dpkg-query`
# version for every derived package -- and an infidelity of this class becomes visible instead
# of inferable. That report enumerates nothing: ripgrep's version appears because ci.yml
# declares ripgrep, and a tool CI adds tomorrow appears with no edit here.
#
# RUNNER BASELINE — the one thing the workflow cannot tell us, and how it stays honest
# -----------------------------------------------------------------------------------
# `runs-on: ubuntu-latest` names an image that preinstalls tools the workflow never has to
# mention -- and the bare `ubuntu:<release>` base has fewer of them than the old node base did,
# so the seed is correspondingly larger. That set is not derivable from the YAML, so a seed
# list lives below — and a seed
# list is exactly the enumerated set this codebase keeps getting burned by, because a
# missing member looks like a member that does not apply. So the incompleteness is made
# LOUD instead of silent: after the run, `report_provisioning_gaps` reads the log for the
# shell's own `<cmd>: command not found` and names every tool that was missing. That check
# enumerates nothing — it derives the gap from the run's own evidence — and a run with any
# gap exits 3 as UNTRUSTED rather than returning a number you would have believed. Add the
# named tool with --extra-packages, or to the seed if CI relies on it permanently.
#
# NO MODEL API — structural, and checked every run
# ------------------------------------------------
# Two independent levers, neither of which relies on a test behaving well:
#   1. the measurement container runs with `--network none`, so no route to any API exists;
#   2. no ANTHROPIC_*/CLAUDE_* variable is passed in (docker does not inherit host env).
# Configuration is a claim, so the container also ASSERTS both before running anything: it
# aborts if any ANTHROPIC_*/CLAUDE_* variable is present, and aborts if a TCP connect to
# api.anthropic.com:443 SUCCEEDS. A run that could have reached the API produces no result
# rather than an untrustworthy one.
#
# EXIT CODES
#   0     the command under test passed
#   1..   the command under test failed (container's own exit code)
#   2     harness refused to run (underivable field, missing docker, bad option)
#   3     the run completed but is UNTRUSTED: a provisioning gap was detected
#   90/91 preflight failed: a credential was present, or the API was reachable
#
# USAGE
#   bash scripts/ci-repro.sh [options]
#     --workflow <path>  workflow to derive from        (default .github/workflows/ci.yml)
#     --ref <git-ref>    commit to check out            (default HEAD)
#     --cmd <string>     command to run in extension/   (default "npm run test:fast")
#     --full             run the derived CI gate command instead of --cmd
#     --print-env        print the derived environment and exit without running anything
#     --rebuild          re-provision even if a matching image exists
#     --extra-packages "a b"  extra apt packages (see RUNNER BASELINE)
#     --runner-release <ver>  ubuntu release to provision (e.g. 24.04); overrides the
#                        resolution of `runs-on`, for use offline or without `gh`
#     --log <path>       log file (default under $TMPDIR)
#     -h, --help         this text
#
# KNOWN LIMITATION: derivation is uniformly fail-closed, so a workflow whose gate is not a single
# `run:` line containing `npm ci &&` is REFUSED (exit 2) even for a run that would not have used the
# gate command -- `.github/workflows/stability-gate.yml` is such a workflow today. That is the
# intended trade: one rule, loudly enforced, beats two classes of derived field where only some
# refuse. Use --workflow with ci.yml or release.yml.
#
# Only committed state at --ref is tested; a dirty working tree is reported and NOT included,
# because a harness that silently tests something other than what it names is the failure mode
# this script exists to remove.

set -euo pipefail

die() { printf 'ci-repro: %s\n' "$*" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

# Tools the GitHub runner image ships that a bare `ubuntu:<release>` does not. Kept minimal
# and evidence-backed: each was named by an actual `command not found` in a measured run, or
# by provisioning failing without it — none is guessed. See RUNNER BASELINE.
#   jq    — install.sh, release-gate.sh, coverage-delta.sh
#   rsync — install.sh, install-agents.sh
#   git   — this script's own checkout step; absent from ubuntu:24.04, which the previous
#           node:<major> base had supplied implicitly as a buildpack-deps derivative.
#   python3 — audit-subsystem-claude-md.sh:15. Named by the f561bc7d noise baseline, which
#           reddened `audit-subsystem-claude-md` twice with `[error: python3 is required]`.
#           Note this one was INVISIBLE to the MISSING_COMMANDS detector below: that detector
#           reads `command not found` out of the log, and a script that probes for its own
#           interpreter and prints a custom error never emits that string. A tool absence is
#           only self-reporting when nothing catches it first.
CI_RUNNER_BASELINE_PACKAGES="git jq python3 rsync"

WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
REF="HEAD"
CMD="npm run test:fast"
USE_FULL_GATE=0
PRINT_ENV_ONLY=0
REBUILD=0
EXTRA_PACKAGES=""
RUNNER_RELEASE_OVERRIDE=""
LOG=""

usage() { sed -n '/^# USAGE/,/^# Only committed/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --workflow) WORKFLOW="$2"; shift 2 ;;
    --ref)      REF="$2"; shift 2 ;;
    --cmd)      CMD="$2"; shift 2 ;;
    --log)      LOG="$2"; shift 2 ;;
    --extra-packages) EXTRA_PACKAGES="$2"; shift 2 ;;
    --runner-release) RUNNER_RELEASE_OVERRIDE="$2"; shift 2 ;;
    --full)     USE_FULL_GATE=1; shift ;;
    --print-env) PRINT_ENV_ONLY=1; shift ;;
    --rebuild)  REBUILD=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Derivation. Each value names the workflow field it came from, so --print-env
# is an auditable statement of what is being reproduced.
# ---------------------------------------------------------------------------
# Resolve the runner LABEL to a concrete ubuntu release. See "RESOLVING `ubuntu-latest`" above:
# this deliberately is not `${CI_RUNS_ON#ubuntu-}`, because for `-latest` that produces a Docker
# Hub tag whose meaning is set by a different vendor on a different schedule.
resolve_runner_release() {
  if [ -n "$RUNNER_RELEASE_OVERRIDE" ]; then
    CI_RUNNER_RELEASE="$RUNNER_RELEASE_OVERRIDE"
    CI_RUNNER_RELEASE_BASIS="--runner-release (operator override)"
    return 0
  fi

  # A pinned label already names the release; nothing to resolve.
  case "${CI_RUNS_ON%-arm}" in
    ubuntu-[0-9]*.[0-9]*)
      CI_RUNNER_RELEASE="${CI_RUNS_ON%-arm}"
      CI_RUNNER_RELEASE="${CI_RUNNER_RELEASE#ubuntu-}"
      CI_RUNNER_RELEASE_BASIS="pinned as '$CI_RUNS_ON' in $(basename "$WORKFLOW")"
      return 0 ;;
  esac

  # `-latest`: ask the runs themselves. `grep -m1` closes the pipe, so gh stops early and this
  # costs about a second rather than a full log download.
  command -v gh >/dev/null 2>&1 || die "runs-on is '$CI_RUNS_ON', whose release only GitHub \
defines, and 'gh' is not on PATH to ask. Re-run with --runner-release <ver> (e.g. 24.04)."
  local wf run_id observed
  wf="$(basename "$WORKFLOW")"
  run_id="$(gh run list --workflow="$wf" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$run_id" ] || die "no completed run of $wf found to resolve '$CI_RUNS_ON' against \
(gh run list returned nothing). Re-run with --runner-release <ver>."
  observed="$( { gh run view "$run_id" --log 2>/dev/null || true; } \
    | grep -m1 -oE 'Image: ubuntu-[0-9]+\.[0-9]+' || true)"
  [ -n "$observed" ] || die "run $run_id of $wf prints no 'Image: ubuntu-<release>' line to \
resolve '$CI_RUNS_ON' from. Re-run with --runner-release <ver>."
  CI_RUNNER_RELEASE="${observed#Image: ubuntu-}"
  CI_RUNNER_RELEASE_BASIS="observed as '$observed' in run $run_id of $wf"
}

derive_ci_env() {
  [ -f "$WORKFLOW" ] || die "workflow file not found: $WORKFLOW"

  CI_RUNS_ON="$(sed -nE 's/^[[:space:]]*runs-on:[[:space:]]*([^[:space:]#]+).*/\1/p' "$WORKFLOW" | head -1)"
  [ -n "$CI_RUNS_ON" ] || die "could not derive 'runs-on' from $WORKFLOW"
  # Load-bearing, not decorative: a Linux container silently "reproducing" a macOS or Windows job
  # would be a harness that agrees with itself about the wrong platform.
  case "$CI_RUNS_ON" in
    ubuntu-*) ;;
    *) die "runs-on '$CI_RUNS_ON' in $WORKFLOW is not an ubuntu runner; this harness reproduces Linux only" ;;
  esac

  resolve_runner_release
  # GitHub suffixes its arm runner labels with `-arm`; absence of the suffix means x64. Pinning
  # this is not decoration: with no --platform the arch of a run is whatever variant happens to
  # be in the local image cache, i.e. a property of pull history rather than of the workflow.
  case "$CI_RUNS_ON" in
    *-arm) CI_PLATFORM="linux/arm64" ;;
    *)     CI_PLATFORM="linux/amd64" ;;
  esac

  CI_NODE_VERSION="$(sed -nE "s/^[[:space:]]*node-version:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?.*/\1/p" "$WORKFLOW" | head -1)"
  [ -n "$CI_NODE_VERSION" ] || die "could not derive 'node-version' from $WORKFLOW"
  CI_NODE_MAJOR="${CI_NODE_VERSION%%.*}"
  case "$CI_NODE_MAJOR" in
    ''|*[!0-9]*) die "derived node-version '$CI_NODE_VERSION' from $WORKFLOW has no numeric major" ;;
  esac

  # Absent apt step = legal (a workflow may not need one). Present-but-unparseable = fail
  # closed: silently installing nothing is exactly the rot this script is built to avoid.
  CI_APT_PACKAGES=""
  if grep -q 'apt-get install' "$WORKFLOW"; then
    CI_APT_PACKAGES="$(sed -nE 's/.*apt-get install -y[[:space:]]+([^&|;]*).*/\1/p' "$WORKFLOW" \
      | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
    [ -n "$CI_APT_PACKAGES" ] || die "$WORKFLOW runs apt-get install but no package list could be derived"
  fi

  # A job that writes `sudo` is not root. Absence of sudo is not evidence of root, so the
  # non-root default stands either way (every GitHub-hosted runner is non-root) — only the
  # stated BASIS changes, and --print-env prints which one applied.
  if grep -qE '(^|[^[:alnum:]_])sudo[[:space:]]' "$WORKFLOW"; then
    CI_NONROOT_BASIS="workflow uses sudo, so the job user is not root"
  else
    CI_NONROOT_BASIS="no sudo in workflow; defaulting to non-root (GitHub-hosted runners are)"
  fi

  CI_COREPACK=0; grep -q 'corepack enable' "$WORKFLOW" && CI_COREPACK=1
  CI_EXTENSION_DIR_IS_WORKSPACE=0
  grep -qF 'EXTENSION_DIR: ${{ github.workspace }}' "$WORKFLOW" && CI_EXTENSION_DIR_IS_WORKSPACE=1
  CI_FETCH_DEPTH="$(sed -nE 's/^[[:space:]]*fetch-depth:[[:space:]]*([0-9]+).*/\1/p' "$WORKFLOW" | head -1)"
  CI_FETCH_DEPTH="${CI_FETCH_DEPTH:-unset}"

  CI_GATE_CMD="$(sed -nE 's/^[[:space:]]*run:[[:space:]]*(.*npm ci &&.*)$/\1/p' "$WORKFLOW" | head -1)"
  [ -n "$CI_GATE_CMD" ] || die "could not derive the gate 'run:' command (a line containing 'npm ci &&') from $WORKFLOW"
  CI_GATE_CMD="${CI_GATE_CMD#cd extension && }"

  ALL_PACKAGES="$(printf '%s %s %s' "$CI_APT_PACKAGES" "$CI_RUNNER_BASELINE_PACKAGES" "$EXTRA_PACKAGES" \
    | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
}

# What the built image IS, as opposed to what the derivation intended. Driven by $ALL_PACKAGES,
# so it names no tool of its own: ripgrep appears here because ci.yml installs ripgrep.
report_image_measurement() {
  # -i is load-bearing: without it the container gets no stdin, `bash -s` reads nothing, and this
  # function prints an empty block that reads exactly like "measured, all fine".
  docker run --rm -i --platform "$CI_PLATFORM" -e PKGS="$ALL_PACKAGES" "$1" bash -s <<'MEASURE_IMG'
. /etc/os-release
printf '    distro           : %s (VERSION_ID=%s) on %s\n' "$PRETTY_NAME" "$VERSION_ID" "$(uname -m)"
printf '    node / npm       : %s / %s\n' "$(node -v)" "$(npm -v)"
for p in $PKGS; do
  ver="$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || true)"
  printf '    pkg %-12s : %s\n' "$p" "${ver:-NOT INSTALLED}"
done
MEASURE_IMG
}

print_env() {
  cat <<EOF
ci-repro derived environment
  workflow            : $WORKFLOW
  runs-on             : $CI_RUNS_ON  (+ runner baseline packages)
  runner release      : ubuntu:$CI_RUNNER_RELEASE — $CI_RUNNER_RELEASE_BASIS
  platform            : $CI_PLATFORM
  node-version        : $CI_NODE_VERSION  -> node:$CI_NODE_MAJOR copied onto ubuntu:$CI_RUNNER_RELEASE
  apt packages        : ${CI_APT_PACKAGES:-(none declared)}
  runner baseline     : $CI_RUNNER_BASELINE_PACKAGES${EXTRA_PACKAGES:+ (+ extra: $EXTRA_PACKAGES)}
  job user            : $JOB_USER (uid $JOB_UID, HOME $JOB_HOME) — $CI_NONROOT_BASIS
  corepack enable     : $([ "$CI_COREPACK" = 1 ] && echo 'yes (pnpm materialised at provision time)' || echo no)
  EXTENSION_DIR       : $([ "$CI_EXTENSION_DIR_IS_WORKSPACE" = 1 ] && echo 'workspace (checkout root)' || echo 'not set by workflow')
  fetch-depth         : $CI_FETCH_DEPTH $([ "$CI_FETCH_DEPTH" = 0 ] && echo '(full history)')
  gate command        : $CI_GATE_CMD
  provisioned image   : $IMAGE
EOF
  # Measured, not derived — and deliberately optional, so --print-env keeps working with no
  # docker daemon and before anything has been built.
  if command -v docker >/dev/null 2>&1 && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "  measured in image   :"
    report_image_measurement "$IMAGE"
  else
    echo "  measured in image   : (not built yet — run without --print-env to provision $IMAGE)"
  fi
}

# The GitHub runner's own identity: uid 1001 with a home two components deep. Both matter --
# the uid so permission-denial tests can actually be denied, the depth because runtime-root
# guards match on `/*/*/.claude/...`, which a one-component /root can never satisfy.
JOB_USER="runner"
JOB_UID=1001
JOB_HOME="/home/runner"

derive_ci_env
[ "$USE_FULL_GATE" = 1 ] && CMD="$CI_GATE_CMD"

RESOLVED_SHA="$(git -C "$REPO_ROOT" rev-parse "$REF")" || die "cannot resolve ref: $REF"
SHORT_SHA="${RESOLVED_SHA:0:12}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-12
  else shasum -a 256 | cut -c1-12; fi
}
# The release and platform are part of the image's identity: without them a distro change
# would silently reuse an image built for the previous one, and every number measured through
# it would describe an environment that is no longer being claimed.
ENV_HASH="$(printf '%s|%s|%s|%s|%s|%s|%s' "$CI_RUNNER_RELEASE" "$CI_PLATFORM" "$CI_NODE_MAJOR" \
  "$ALL_PACKAGES" "$CI_COREPACK" "$CI_EXTENSION_DIR_IS_WORKSPACE" "$JOB_UID" | sha256_of)"
IMAGE="pickle-ci-repro:${SHORT_SHA}-${ENV_HASH}"
BASE_IMAGE="pickle-ci-repro-base:${CI_RUNNER_RELEASE}-node${CI_NODE_MAJOR}-${CI_PLATFORM##*/}"

if [ "$PRINT_ENV_ONLY" = 1 ]; then print_env; exit 0; fi

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || die "docker daemon not reachable (docker version failed)"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  printf 'ci-repro: NOTE working tree is dirty; only committed state at %s is tested.\n' "$SHORT_SHA" >&2
fi

LOG="${LOG:-${TMPDIR:-/tmp}/pickle-ci-repro-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ).log}"

# ---------------------------------------------------------------------------
# Provision (network ON): real checkout + CI's tooling + npm ci, snapshotted.
# Split from measurement because `npm ci` needs the network and the measured run
# must not have it.
# ---------------------------------------------------------------------------
# The runner's userland with the derived node laid on top. Two named images and an empty build
# context — nothing is fetched by URL, so there is no tarball, arch token or checksum to keep
# right, and node remains exactly the build actions/setup-node would have installed.
build_base_image() {
  local ctx
  ctx="$(mktemp -d)"
  printf 'ci-repro: building %s (ubuntu:%s + node:%s, %s)\n' \
    "$BASE_IMAGE" "$CI_RUNNER_RELEASE" "$CI_NODE_MAJOR" "$CI_PLATFORM" >&2
  if ! docker build --platform "$CI_PLATFORM" -t "$BASE_IMAGE" -f - "$ctx" <<DOCKERFILE
FROM ubuntu:$CI_RUNNER_RELEASE
COPY --from=node:$CI_NODE_MAJOR /usr/local /usr/local
# /opt as well, and not optionally: the node image splits its runtime across both trees --
# /usr/local/bin/yarn and yarnpkg are symlinks into /opt/yarn-v*. Copying only /usr/local
# leaves them dangling, and `corepack enable` aborts on the realpath of yarnpkg rather than
# on anything to do with pnpm. Named by a measured provisioning run, not predicted.
COPY --from=node:$CI_NODE_MAJOR /opt /opt
DOCKERFILE
  then
    rmdir "$ctx" 2>/dev/null || true
    die "could not build base image $BASE_IMAGE (ubuntu:$CI_RUNNER_RELEASE + node:$CI_NODE_MAJOR)"
  fi
  rmdir "$ctx" 2>/dev/null || true
}

provision() {
  local container="pickle-ci-repro-provision-$$"
  docker rm -f "$container" >/dev/null 2>&1 || true
  build_base_image
  printf 'ci-repro: provisioning %s from %s (network ON)\n' "$IMAGE" "$BASE_IMAGE" >&2

  if ! docker run --name "$container" -i --platform "$CI_PLATFORM" \
        -e CI_ALL_PACKAGES="$ALL_PACKAGES" \
        -e CI_COREPACK="$CI_COREPACK" \
        -e CI_TARGET_SHA="$RESOLVED_SHA" \
        -e JOB_USER="$JOB_USER" -e JOB_UID="$JOB_UID" -e JOB_HOME="$JOB_HOME" \
        -v "$REPO_ROOT":/src:ro \
        "$BASE_IMAGE" bash -s <<'PROVISION'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if [ -n "${CI_ALL_PACKAGES:-}" ]; then
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $CI_ALL_PACKAGES
fi

# The unprivileged job user CI runs as. Created before npm ci so the tree it produces is
# owned by the user that will read it, exactly as a real checkout is.
useradd --create-home --home-dir "$JOB_HOME" --uid "$JOB_UID" --shell /bin/bash "$JOB_USER"

# The bind mount is owned by a foreign uid, so git refuses to read it without this.
git config --global --add safe.directory /src
# No --depth: reproduces the workflow's fetch-depth: 0 (full history). --no-hardlinks so the
# clone owns its objects instead of sharing inodes with the read-only host repo.
git clone --no-hardlinks --quiet /src /work/repo
git -C /work/repo checkout --detach --quiet "$CI_TARGET_SHA"
chown -R "$JOB_UID":"$JOB_UID" /work

if [ "${CI_COREPACK:-0}" = 1 ]; then
  corepack enable
  # `corepack enable` only writes shims; the first pnpm call fetches the real package from
  # registry.npmjs.org. Do that here, while the network exists, so the measured run does not
  # need it. Done as the job user because the cache lives under that user's HOME.
  su - "$JOB_USER" -c 'pnpm --version' >/dev/null
fi

su - "$JOB_USER" -c 'cd /work/repo/extension && npm ci'
PROVISION
  then
    docker rm -f "$container" >/dev/null 2>&1 || true
    die "provisioning failed (see output above)"
  fi

  docker commit "$container" "$IMAGE" >/dev/null
  docker rm -f "$container" >/dev/null
  printf 'ci-repro: provisioned %s\n' "$IMAGE" >&2
}

if [ "$REBUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  provision
else
  printf 'ci-repro: reusing image %s (--rebuild to re-provision)\n' "$IMAGE" >&2
fi

# ---------------------------------------------------------------------------
# Measure (network OFF), as the unprivileged job user. EXTENSION_DIR is what CI
# uses instead of a deployed runtime; CI=true is a property of every CI runner,
# not of this repo's workflow.
# ---------------------------------------------------------------------------
# Seeded with CI=true -- a property of every CI runner, and it keeps the array non-empty: bash 3.2
# (the macOS system shell) treats "${arr[@]}" on an empty array as an unbound variable under `set -u`,
# which would break exactly the workflows that do not set EXTENSION_DIR.
RUN_ENV_ARGS=(-e CI=true)
[ "$CI_EXTENSION_DIR_IS_WORKSPACE" = 1 ] && RUN_ENV_ARGS+=(-e EXTENSION_DIR=/work/repo)

printf 'ci-repro: sha=%s image=%s\nci-repro: cmd=%s\nci-repro: log=%s\n' \
  "$RESOLVED_SHA" "$IMAGE" "$CMD" "$LOG" >&2

set +e
docker run --rm -i --network none --platform "$CI_PLATFORM" \
  --user "$JOB_UID:$JOB_UID" \
  -e HOME="$JOB_HOME" \
  "${RUN_ENV_ARGS[@]}" \
  -e CI_REPRO_CMD="$CMD" \
  "$IMAGE" bash -s <<'MEASURE' 2>&1 | tee "$LOG"
set -uo pipefail

# Assertion 1: no credential can have arrived, whatever the caller's environment.
if env | grep -qE '^(ANTHROPIC|CLAUDE)_'; then
  echo "ci-repro PREFLIGHT FAIL: an ANTHROPIC_/CLAUDE_ variable is present in the container" >&2
  exit 90
fi
# Assertion 2: no route to the model API. Under --network none this connect cannot succeed;
# if it ever does, the isolation is broken and the run must produce no result at all.
node -e '
const net = require("net");
const s = net.connect({ host: "api.anthropic.com", port: 443 });
const ok = (why) => { console.log("ci-repro preflight: no model-API route (" + why + ")"); process.exit(0); };
s.setTimeout(4000);
s.on("connect", () => { console.error("ci-repro PREFLIGHT FAIL: reached api.anthropic.com:443"); process.exit(91); });
s.on("error", (e) => ok(e.code || "error"));
s.on("timeout", () => ok("timeout"));
' || exit 91
# Assertion 3: the run is unprivileged. Root silently passes permission-denial tests, so a
# root run would report a pass count this harness has no right to report.
if [ "$(id -u)" = 0 ]; then
  echo "ci-repro PREFLIGHT FAIL: running as root; CI's job user is unprivileged" >&2
  exit 92
fi

cd /work/repo/extension
echo "ci-repro: running: $CI_REPRO_CMD"
eval "$CI_REPRO_CMD"
MEASURE
EXIT_CODE=${PIPESTATUS[0]}
set -e

count_of() { awk -v k="$1" '($1=="#"||$1=="\xe2\x84\xb9") && NF==3 && $2==k && $3 ~ /^[0-9]+$/ {s+=$3} END{print s+0}' "$LOG"; }

# Derived from the run's own evidence, not from a list of tools: the shell says exactly which
# command it could not find. A gap here means the environment, not the code, produced the
# result — so the result is not reported as trustworthy.
# `|| true` is load-bearing: no match makes grep exit 1, and under `pipefail` that would abort the
# script BEFORE the summary and return 1 for a run that actually passed — a clean result reported as
# a failure is the same fake signal this harness exists to remove.
MISSING_COMMANDS="$( { grep -oE '[[:alnum:]_.+-]+: command not found' "$LOG" || true; } \
  | sed 's/: command not found//' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

cat >&2 <<EOF

ci-repro summary
  workflow reproduced : $WORKFLOW
  ref / sha           : $REF -> $RESOLVED_SHA
  image               : $IMAGE
  command             : $CMD
  job user            : $JOB_USER (uid $JOB_UID)
  tests / pass        : $(count_of tests) / $(count_of pass)
  fail / cancelled    : $(count_of fail) / $(count_of cancelled)
  container exit code : $EXIT_CODE
  log                 : $LOG
EOF

# Reporting what the image is must never change what the run REPORTS. Under `set -e` an
# unreadable image (daemon stopped, image pruned mid-run) would abort here and return docker's
# status instead of the command's — the same fake signal the `|| true` above exists to prevent.
{ echo "  measured in image   :"
  report_image_measurement "$IMAGE" || echo "    (image could not be measured; run result below is unaffected)"
} >&2

if [ -n "$MISSING_COMMANDS" ]; then
  cat >&2 <<EOF

ci-repro: HARNESS PROVISIONING GAP — result is UNTRUSTED
  commands not found in the container : $MISSING_COMMANDS
  ubuntu-latest preinstalls tools this base image does not. Re-run with:
    --extra-packages "<packages providing: $MISSING_COMMANDS>"
  or add them to CI_RUNNER_BASELINE_PACKAGES if CI depends on them permanently.
EOF
  exit 3
fi

exit "$EXIT_CODE"
