#!/usr/bin/env bash
set -euo pipefail

REPO="gregorydickson/pickle-rick-claude"
RELEASE_GATE_TMPDIR=""
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
PKG_DISPLAY_PATH="extension/package.json"

[ -n "$REPO_ROOT" ] || {
  echo "release-gate: must run inside a git worktree (exit 12)" >&2
  exit 12
}

PKG_PATH="$REPO_ROOT/$PKG_DISPLAY_PATH"

usage() {
  cat >&2 <<'USAGE'
usage: bin/release-gate.sh --pre-tag <tag>
       bin/release-gate.sh --post-tag <tag>

exit codes:
  10 pre-tag package version mismatch
  11 jq parse failed
  12 tag or tagged package missing
  20 release download failed
  21 downloaded tarball package version mismatch
  22 GitHub release API error
USAGE
}

die() {
  local code="$1"
  shift
  echo "release-gate: $* (exit $code)" >&2
  exit "$code"
}

read_expected_version() {
  local version
  version="$(jq -r '.version' "$PKG_PATH" 2>/dev/null)" || die 11 "could not parse $PKG_DISPLAY_PATH with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_DISPLAY_PATH missing version"
  printf '%s\n' "$version"
}

read_tag_name_version() {
  local tag="$1"
  local version="${tag#v}"
  # The prerelease suffix must stay optional-but-accepted: every tag this repo ships is X.Y.Z-beta.N.
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die 12 "tag $tag is not a semver release tag"
  printf '%s\n' "$version"
}

read_tag_version() {
  local tag="$1"
  local pkg
  git -C "$REPO_ROOT" rev-parse -q --verify "$tag^{commit}" >/dev/null 2>&1 || die 12 "tag $tag not found"
  pkg="$(git -C "$REPO_ROOT" show "$tag:$PKG_DISPLAY_PATH" 2>/dev/null)" || die 12 "$PKG_DISPLAY_PATH missing at tag $tag"
  local version
  version="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 11 "could not parse $PKG_DISPLAY_PATH at tag $tag with jq"
  [ -n "$version" ] && [ "$version" != "null" ] || die 11 "$PKG_DISPLAY_PATH at tag $tag missing version"
  printf '%s\n' "$version"
}

# Every scan below consumes a listing that `read_tarball_listing` already materialized and
# status-checked — never a live `tar | awk` pipe. Under `set -o pipefail` a pipeline yields TAR's
# status whenever tar fails, and that status MASKS awk's verdict: awk exits 0 on a detected
# offending member, tar's non-zero wins, and the `if`-guard at the callsite reads non-zero as
# "clean". A truncated archive carrying an escaping symlink therefore false-greened the release
# while awk was printing the very link it missed. `printf` cannot fail, so awk's verdict is the
# pipeline's verdict here, and an unlistable archive is a hard stop (die 21) rather than a pass.
read_tarball_listing() {
  local tarball="$1"
  shift
  tar "$@" "$tarball"
}

list_installable_payload_roots() {
  local listing="$1"
  printf '%s\n' "$listing" | awk '
    function is_safe_root(root) {
      return root == "" || (root !~ /^\// && root !~ /(^|\/)\.\.?($|\/)/)
    }
    function normalized(entry) {
      sub(/^\.\//, "", entry)
      sub(/\/$/, "", entry)
      return entry
    }
    {
      entry = normalized($0)
      if (entry == "extension/package.json") {
        pkg[""] = 1
      } else if (entry ~ /\/extension\/package\.json$/) {
        root = entry
        sub(/\/extension\/package\.json$/, "", root)
        if (is_safe_root(root)) {
          pkg[root] = 1
        }
      }

      if (entry == "install.sh") {
        install[""] = 1
      } else if (entry ~ /\/install\.sh$/) {
        root = entry
        sub(/\/install\.sh$/, "", root)
        if (is_safe_root(root)) {
          install[root] = 1
        }
      }
    }
    END {
      for (root in pkg) {
        if (root in install) {
          print root
        }
      }
    }
  '
}

find_installable_payload_root() {
  local listing="$1"
  local -a roots=()
  local root

  while IFS= read -r root; do
    roots+=("$root")
  done < <(list_installable_payload_roots "$listing")

  [ ${#roots[@]} -gt 0 ] || return 1
  [ ${#roots[@]} -eq 1 ] || return 2
  printf '%s\n' "${roots[0]}"
}

listing_has_unsafe_entries() {
  local listing="$1"
  printf '%s\n' "$listing" | awk '
    function normalized(entry) {
      sub(/^\.\//, "", entry)
      sub(/\/$/, "", entry)
      return entry
    }
    {
      entry = normalized($0)
      if (!found && (entry ~ /^\// || entry ~ /(^|\/)\.\.?($|\/)/)) {
        print entry
        found = 1
      }
    }
    END {
      exit(found ? 0 : 1)
    }
  '
}

# `listing_has_unsafe_entries` scans member NAMES only (`tar -tzf`), so a symlink or hardlink
# whose NAME is safe but whose TARGET escapes the payload root sails through: the extractor writes
# members that land after the link THROUGH it, escaping the install prefix. `-tvzf` is the only
# listing that exposes the entry type (mode field first char: `l` symlink, `h` hardlink — portable
# across GNU and BSD tar). The real installer payload contains no links, so a blanket rejection of
# every link member cannot false-RED a legitimate release. Drain to END — never a bare `exit` on
# first match — or pipefail SIGPIPEs the still-writing producer on a >64KB listing (see
# release-gate.sh trap door).
listing_has_link_entries() {
  local listing="$1"
  printf '%s\n' "$listing" | awk '
    {
      type = substr($1, 1, 1)
      if (!found && (type == "l" || type == "h")) {
        print $0
        found = 1
      }
    }
    END {
      exit(found ? 0 : 1)
    }
  '
}

select_installable_tarball() {
  local dir="$1"
  local tag="$2"
  local -a downloaded=()
  local -a installable=()
  local tarball name_listing verbose_listing

  while IFS= read -r tarball; do
    [ -n "$tarball" ] || continue
    downloaded+=("$tarball")
  done < <(find "$dir" -type f -name '*.tar.gz' -print)

  [ ${#downloaded[@]} -gt 0 ] || die 20 "release download produced no tar.gz asset for $tag"

  for tarball in "${downloaded[@]}"; do
    # Fail closed here, where `die` still reaches the caller: an `if`-guard suppresses `set -e`,
    # so a `die` raised from inside one of the scans below would only exit its own subshell.
    name_listing="$(read_tarball_listing "$tarball" -tzf)" ||
      die 21 "could not list archive entries of downloaded tarball $tarball"
    verbose_listing="$(read_tarball_listing "$tarball" -tvzf)" ||
      die 21 "could not list archive entries of downloaded tarball $tarball"

    if unsafe_entry="$(listing_has_unsafe_entries "$name_listing")"; then
      die 21 "downloaded tarball contains unsafe archive entry $unsafe_entry"
    fi
    if link_entry="$(listing_has_link_entries "$verbose_listing")"; then
      die 21 "downloaded tarball contains a symlink or hardlink member: $link_entry"
    fi
    if payload_root="$(find_installable_payload_root "$name_listing")"; then
      installable+=("$tarball")
    else
      status=$?
      [ "$status" -eq 1 ] || die 21 "downloaded tarball contains multiple install payload roots shared by $PKG_DISPLAY_PATH and install.sh"
    fi
  done

  [ ${#installable[@]} -gt 0 ] || die 21 "downloaded tarball is missing install payload root shared by $PKG_DISPLAY_PATH and install.sh"
  [ ${#installable[@]} -eq 1 ] || die 21 "release $tag downloaded multiple installable tar.gz assets"
  printf '%s\n' "${installable[0]}"
}

pre_tag() {
  local tag="$1"
  local expected tag_name_version tagged
  expected="$(read_expected_version)"
  tag_name_version="$(read_tag_name_version "$tag")"
  tagged="$(read_tag_version "$tag")"
  [ "$expected" = "$tag_name_version" ] || die 10 "expected release tag $tag to match $PKG_DISPLAY_PATH version $expected"
  [ "$expected" = "$tagged" ] || die 10 "expected $PKG_DISPLAY_PATH version $expected but tag $tag has $tagged"
  echo "ok: tag $tag has $PKG_DISPLAY_PATH version $expected"
}

post_tag() {
  local tag="$1"
  local expected tag_name_version tagged_commit_version tmpdir
  expected="$(read_expected_version)"
  tag_name_version="$(read_tag_name_version "$tag")"
  tagged_commit_version="$(read_tag_version "$tag")"
  [ "$expected" = "$tag_name_version" ] || die 21 "expected release tag $tag to match $PKG_DISPLAY_PATH version $expected"
  [ "$expected" = "$tagged_commit_version" ] || die 21 "expected $PKG_DISPLAY_PATH version $expected but tag $tag has $tagged_commit_version"
  gh api "repos/$REPO/releases/tags/$tag" >/dev/null 2>&1 || die 22 "GitHub release API check failed for $tag"
  tmpdir="$(mktemp -d)"
  RELEASE_GATE_TMPDIR="$tmpdir"
  trap 'rm -rf "$RELEASE_GATE_TMPDIR"' EXIT
  gh release download "$tag" -R "$REPO" -p '*.tar.gz' -D "$tmpdir" >/dev/null 2>&1 || die 20 "release download failed for $tag"

  local tarball payload_root pkg_member pkg tagged name_listing
  tarball="$(select_installable_tarball "$tmpdir" "$tag")"
  name_listing="$(read_tarball_listing "$tarball" -tzf)" ||
    die 21 "could not list archive entries of downloaded tarball $tarball"
  payload_root="$(find_installable_payload_root "$name_listing")" || {
    status=$?
    [ "$status" -eq 1 ] || die 21 "downloaded tarball contains multiple install payload roots shared by $PKG_DISPLAY_PATH and install.sh"
    die 21 "downloaded tarball is missing install payload root shared by $PKG_DISPLAY_PATH and install.sh"
  }
  if [ -n "$payload_root" ]; then
    pkg_member="$payload_root/extension/package.json"
  else
    pkg_member="extension/package.json"
  fi
  [ -n "$pkg_member" ] || die 21 "downloaded tarball is missing $PKG_DISPLAY_PATH"
  pkg="$(tar -xOzf "$tarball" "$pkg_member" 2>/dev/null)" || die 21 "could not read $PKG_DISPLAY_PATH from downloaded tarball"
  tagged="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 21 "could not parse $PKG_DISPLAY_PATH from downloaded tarball"
  [ -n "$tagged" ] && [ "$tagged" != "null" ] || die 21 "downloaded tarball $PKG_DISPLAY_PATH missing version"
  [ "$expected" = "$tagged" ] || die 21 "expected downloaded $PKG_DISPLAY_PATH version $expected but found $tagged"
  echo "ok: release $tag tarball has $PKG_DISPLAY_PATH version $expected"
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

case "$1" in
  --pre-tag) pre_tag "$2" ;;
  --post-tag) post_tag "$2" ;;
  *) usage; exit 2 ;;
esac
