#!/usr/bin/env bash
# Read-only, report-only auditor for v* release tags.
#
# For each v* tag on <remote> (default: origin), reports:
#   - the commit it resolves to (peel-dereferenced for annotated tags by
#     the shared list_tag_shas_from_listing -- see resolve-tag-sha.sh),
#   - the extension/package.json version present in THAT tree,
#   - the version implied by the tag name,
#   - a verdict: OK (versions match) / MISPOINTED (versions differ) /
#     UNKNOWN (the tree has no extension/package.json, or its version
#     field could not be read -- reported, never a crash).
#
# Exits non-zero when any row is MISPOINTED, so it can run as a check.
#
# HARD CONSTRAINT: this script MUST NOT mutate remote state. No git push,
# no git tag -d, no gh release delete/edit. It only reads and prints; a
# human acts on the findings.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-tag-sha.sh
source "$SCRIPT_DIR/resolve-tag-sha.sh"

usage() {
  echo "Usage: $(basename "$0") [<remote>]" >&2
  echo "  For each v* tag on <remote> (default: origin), reports the commit" >&2
  echo "  it resolves to, the extension/package.json version in that tree," >&2
  echo "  the version implied by the tag name, and a verdict: OK / MISPOINTED" >&2
  echo "  / UNKNOWN. Exits non-zero if any tag is MISPOINTED. Read-only." >&2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi

remote="${1:-origin}"

# ONE network round-trip for the whole audit. This listing already carries
# every tag's sha alongside its ref -- including the `^{}` peel line for
# annotated tags -- so the per-tag sha is read back out of it below rather
# than re-queried. Re-querying was not merely slow (measured 2m32s vs 0.4s
# over 258 tags): each per-tag call was an independent chance to fail, and
# a failure was indistinguishable from "tag absent", so ONE transient
# network error silently dropped that tag's row and left the audit GREEN
# with a MISPOINTED tag in the set. See extension/CLAUDE.md trap door
# AP-EXT-ITER65-01.
listing="$(git ls-remote --tags "$remote" 'refs/tags/v*')"

if [ -z "$listing" ]; then
  echo "no v* tags found on remote '$remote'" >&2
  exit 0
fi

# `<tag><TAB><commit-sha>` per tag, peel-dereferenced by the shared rule.
tag_shas="$(list_tag_shas_from_listing "$listing")"

any_mispointed=0

printf '%-28s %-11s %-40s %-16s %-16s\n' "TAG" "VERDICT" "COMMIT" "TAG_VERSION" "TREE_VERSION"

while IFS="$(printf '\t')" read -r tag sha; do
  [ -n "$tag" ] || continue

  tag_version="${tag#v}"

  # Unrepresentable by construction: `tag` was derived from the very listing
  # `sha` is read from. If it ever fires it is a bug in the parser, so it is
  # LOUD -- never a `continue`, which would drop the row and let the audit
  # report green on a tag it never actually examined.
  if [ -z "$sha" ]; then
    echo "internal error: tag '$tag' appeared in the listing without a sha" >&2
    exit 1
  fi

  # `$remote` may be a named remote (e.g. "origin", production use) or a
  # local repo path (test fixtures / a local mirror). `git show` needs to
  # run against a repo that actually holds the object -- for a path
  # remote that means `git -C "$remote"`; for a named remote it means the
  # current repo (whose object store already has the fetched objects).
  # Try the path form first and fall back to the current-repo form so
  # both cases work without a network fetch.
  tree_version=""
  pkg_json=""
  if pkg_json="$(git -C "$remote" show "$sha:extension/package.json" 2>/dev/null)" \
    || pkg_json="$(git show "$sha:extension/package.json" 2>/dev/null)"; then
    tree_version="$(printf '%s' "$pkg_json" \
      | grep -m1 -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' \
      | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/' || true)"
  fi

  verdict="UNKNOWN"
  if [ -n "$tree_version" ]; then
    if [ "$tree_version" = "$tag_version" ]; then
      verdict="OK"
    else
      verdict="MISPOINTED"
      any_mispointed=1
    fi
  fi

  printf '%-28s %-11s %-40s %-16s %-16s\n' "$tag" "$verdict" "$sha" "$tag_version" "${tree_version:-<absent>}"
done <<< "$tag_shas"

if [ "$any_mispointed" -eq 1 ]; then
  exit 1
fi
exit 0
