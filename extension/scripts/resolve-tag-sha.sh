#!/usr/bin/env bash
# Shared tag -> commit sha resolution. Source this file; it defines
# resolve_tag_sha and takes no action on its own.
#
# Extracted from verify-release-tag.sh (ticket e98d9866) so
# reconcile-release-tags.sh (ticket ae3296ab) can reuse the exact same
# deref logic instead of re-deriving it -- see CLAUDE.md's "enumerated set
# is a liability" guidance: two copies of "how to deref a tag" is the
# duplication shape it bans.
#
# resolve_tag_sha <tag> [<remote>]
#   Prints the commit sha <tag> resolves to on <remote> (default: origin)
#   to stdout and returns 0. Returns 1 (prints nothing) if the tag is
#   absent on the remote. Read-only: never pushes, creates, or deletes tags.
resolve_tag_sha() {
  local tag="$1"
  local remote="${2:-origin}"

  # Query both the bare ref and its `^{}` peel explicitly. Filtering
  # ls-remote by the bare tag name alone (`git ls-remote --tags "$remote"
  # "$tag"`) matches only refs/tags/<tag> and silently drops the
  # ^{}-peeled line for annotated tags -- reintroducing the "tag object
  # sha mistaken for commit sha" bug this function exists to prevent. Two
  # explicit refspecs avoid that pitfall.
  local ls_remote_output
  ls_remote_output="$(git ls-remote "$remote" "refs/tags/$tag" "refs/tags/$tag^{}")"

  if [ -z "$ls_remote_output" ]; then
    return 1
  fi

  # An annotated tag returns two lines: the tag object's own sha, and a
  # second line suffixed `^{}` that dereferences to the commit sha. A
  # lightweight tag returns only the single (already-commit) line. The tag
  # object's own sha is NOT the commit sha, so the `^{}` line must win
  # when present.
  local deref_line actual_sha
  deref_line="$(printf '%s\n' "$ls_remote_output" | grep -F '^{}' || true)"
  if [ -n "$deref_line" ]; then
    actual_sha="$(printf '%s\n' "$deref_line" | awk '{print $1}')"
  else
    actual_sha="$(printf '%s\n' "$ls_remote_output" | head -n1 | awk '{print $1}')"
  fi

  if [ -z "$actual_sha" ]; then
    return 1
  fi

  printf '%s\n' "$actual_sha"
  return 0
}
