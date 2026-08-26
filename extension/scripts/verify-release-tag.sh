#!/usr/bin/env bash
# Resolve a tag's commit sha on a remote and COMPARE it to an expected sha.
# Existence alone is not verification (see CLAUDE.md Versioning section / B-RELTAG):
# `git ls-remote --tags origin <tag>` printed a sha after both beta.16 and beta.17
# and both were misread as success because nothing compared it to what was expected.
# Read-only: never pushes, creates, or deletes tags.
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <tag> <expected-sha> [<remote>]" >&2
  echo "  Compares the commit sha a tag resolves to on <remote> (default: origin)" >&2
  echo "  against <expected-sha>. Exits non-zero on mismatch or if the tag is absent." >&2
}

fail_absent() {
  echo "tag '$tag' not found on remote '$remote'" >&2
  echo "expected=$expected_sha actual=<absent>"
  exit 1
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 1
fi

tag="$1"
expected_sha="$2"
remote="${3:-origin}"

if [[ ! "$expected_sha" =~ ^[0-9a-fA-F]{4,40}$ ]]; then
  echo "expected-sha must be a 4-40 character hex commit sha, got: '$expected_sha'" >&2
  usage
  exit 1
fi

# Query both the bare ref and its `^{}` peel explicitly. Filtering ls-remote
# by the bare tag name alone (`git ls-remote --tags "$remote" "$tag"`) matches
# only refs/tags/<tag> and silently drops the ^{}-peeled line for annotated
# tags -- reintroducing the "tag object sha mistaken for commit sha" bug this
# script exists to prevent. Two explicit refspecs avoid that pitfall.
ls_remote_output="$(git ls-remote "$remote" "refs/tags/$tag" "refs/tags/$tag^{}")"

if [ -z "$ls_remote_output" ]; then
  fail_absent
fi

# An annotated tag returns two lines: the tag object's own sha, and a second
# line suffixed `^{}` that dereferences to the commit sha. A lightweight tag
# returns only the single (already-commit) line. The tag object's own sha is
# NOT the commit sha, so the `^{}` line must win when present.
deref_line="$(printf '%s\n' "$ls_remote_output" | grep -F '^{}' || true)"
if [ -n "$deref_line" ]; then
  actual_sha="$(printf '%s\n' "$deref_line" | awk '{print $1}')"
else
  actual_sha="$(printf '%s\n' "$ls_remote_output" | head -n1 | awk '{print $1}')"
fi

if [ -z "$actual_sha" ]; then
  fail_absent
fi

if [[ "$actual_sha" != "$expected_sha"* ]]; then
  echo "tag '$tag' on remote '$remote' does NOT match expected sha" >&2
  echo "expected=$expected_sha actual=$actual_sha"
  exit 1
fi

echo "expected=$expected_sha actual=$actual_sha"
exit 0
