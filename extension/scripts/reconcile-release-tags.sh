#!/usr/bin/env bash
# Read-only, report-only auditor for v* release tags.
#
# For each v* tag on <remote> (default: origin), reports:
#   - the commit it resolves to (deref ^{} for annotated tags, via the
#     shared resolve_tag_sha function -- see resolve-tag-sha.sh),
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

# List v* tag short names on the remote: strip the refs/tags/ prefix and
# any ^{} peel suffix, then dedupe -- an annotated tag otherwise appears
# twice (once for the tag object ref, once for its peeled commit ref).
tag_names="$(git ls-remote --tags "$remote" 'refs/tags/v*' \
  | awk '{print $2}' \
  | sed -e 's#^refs/tags/##' -e 's/\^{}$//' \
  | sort -u)"

if [ -z "$tag_names" ]; then
  echo "no v* tags found on remote '$remote'" >&2
  exit 0
fi

any_mispointed=0

printf '%-28s %-11s %-40s %-16s %-16s\n' "TAG" "VERDICT" "COMMIT" "TAG_VERSION" "TREE_VERSION"

while IFS= read -r tag; do
  [ -n "$tag" ] || continue

  tag_version="${tag#v}"

  sha=""
  if ! sha="$(resolve_tag_sha "$tag" "$remote")"; then
    echo "tag '$tag' listed but unresolvable on remote '$remote' (raced?)" >&2
    continue
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
done <<< "$tag_names"

if [ "$any_mispointed" -eq 1 ]; then
  exit 1
fi
exit 0
