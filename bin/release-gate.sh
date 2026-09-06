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

# `normalized()` above strips a leading `./` when DERIVING the payload root, but `tar -xOzf`
# matches a member by the name as STORED: GNU tar cannot find `extension/package.json` in an
# archive holding `./extension/package.json`, while bsdtar normalizes the request and does — so
# rebuilding the member name from the stripped root false-REDs a valid release on Linux only, and
# blames the tarball ("could not read") for the gate's own divergence. Read the stored name back
# out of the same listing the root came from. `ENVIRON` rather than `-v` because `-v` applies
# escape processing to the value. Drain to END — never a bare `exit` on first match — or pipefail
# SIGPIPEs the still-writing producer on a >64KB listing (see release-gate.sh trap door).
payload_pkg_member() {
  local listing="$1"
  local root="$2"
  printf '%s\n' "$listing" | RELEASE_GATE_PAYLOAD_ROOT="$root" awk '
    function normalized(entry) {
      sub(/^\.\//, "", entry)
      sub(/\/$/, "", entry)
      return entry
    }
    BEGIN {
      root = ENVIRON["RELEASE_GATE_PAYLOAD_ROOT"]
      want = (root == "" ? "" : root "/") "extension/package.json"
    }
    {
      if (!found && normalized($0) == want) {
        print $0
        found = 1
      }
    }
  '
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

# Payload COMPLETENESS is not decidable from sentinel members. Every scan above asks whether the
# archive is SAFE or uniquely rooted; none asks whether the runtime it carries can LOAD, so
# `--post-tag` printed `ok:` for four months over an asset missing `extension/lib/` entirely. A
# member allow-list here would rot exactly the way the workflow's did, so derive the requirement
# from the payload's OWN bytes: every relative static specifier in every shipped `.js` must name a
# file the same payload carries. A runtime directory added later needs no edit here.
payload_relative_specifiers() {
  local file="$1"
  grep -Eo "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"\${]*\.(js|json)['\"]" "$file" |
    sed -E "s/^.*['\"](.*)['\"]$/\1/" || true
}

# Materialize the file list and each specifier list before consuming them, and decide in the
# CALLER — a bare early exit mid-pipe SIGPIPEs the still-writing producer, the same trap the
# archive scans above document. Resolution is the filesystem's (`..` segments included), which is
# why this runs on an EXTRACTED payload rather than against the member listing.
#
# Status 1 (measured, clean) and status 2 (nothing measured) are DIFFERENT answers: a sweep over an
# empty module set reports no unresolved specifier for the same reason a complete payload does, so
# collapsing them lets an asset carrying no runtime at all read as agreement — the very false-green
# this sweep exists to close, in its most extreme form. Same no-measurement-is-not-a-verdict rule
# `verify-recapture-fired.js` already applies to its activity scan, and the same 1-vs-2 idiom
# `find_installable_payload_root` above uses to separate absent from ambiguous.
payload_unresolved_import() {
  local payload_dir="$1"
  local -a files=()
  local file spec specs

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    files+=("$file")
  done < <(find "$payload_dir" -type f -name '*.js' -print)

  [ ${#files[@]} -gt 0 ] || return 2

  for file in "${files[@]}"; do
    specs="$(payload_relative_specifiers "$file")"
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      if [ ! -f "$(dirname "$file")/$spec" ]; then
        printf '%s -> %s\n' "${file#"$payload_dir"/}" "$spec"
        return 0
      fi
    done <<< "$specs"
  done
  return 1
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

  local tarball payload_root pkg_member pkg tagged name_listing payload_dir unresolved_import
  tarball="$(select_installable_tarball "$tmpdir" "$tag")"
  name_listing="$(read_tarball_listing "$tarball" -tzf)" ||
    die 21 "could not list archive entries of downloaded tarball $tarball"
  payload_root="$(find_installable_payload_root "$name_listing")" || {
    status=$?
    [ "$status" -eq 1 ] || die 21 "downloaded tarball contains multiple install payload roots shared by $PKG_DISPLAY_PATH and install.sh"
    die 21 "downloaded tarball is missing install payload root shared by $PKG_DISPLAY_PATH and install.sh"
  }
  pkg_member="$(payload_pkg_member "$name_listing" "$payload_root")"
  [ -n "$pkg_member" ] || die 21 "downloaded tarball is missing $PKG_DISPLAY_PATH"
  pkg="$(tar -xOzf "$tarball" "$pkg_member" 2>/dev/null)" || die 21 "could not read $PKG_DISPLAY_PATH from downloaded tarball"
  tagged="$(printf '%s\n' "$pkg" | jq -r '.version' 2>/dev/null)" || die 21 "could not parse $PKG_DISPLAY_PATH from downloaded tarball"
  [ -n "$tagged" ] && [ "$tagged" != "null" ] || die 21 "downloaded tarball $PKG_DISPLAY_PATH missing version"
  [ "$expected" = "$tagged" ] || die 21 "expected downloaded $PKG_DISPLAY_PATH version $expected but found $tagged"
  # Last, and only here: extracting is safe ONLY because `select_installable_tarball` already
  # rejected every traversal and link member. Keep this downstream of that guard.
  payload_dir="$tmpdir/payload"
  mkdir -p "$payload_dir"
  tar -xzf "$tarball" -C "$payload_dir" || die 21 "could not extract downloaded tarball $tarball"
  if unresolved_import="$(payload_unresolved_import "$payload_dir")"; then
    die 21 "downloaded tarball ships a runtime that cannot load: $unresolved_import"
  else
    status=$?
    [ "$status" -eq 1 ] || die 21 "downloaded tarball carries no runtime modules to verify"
  fi
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
