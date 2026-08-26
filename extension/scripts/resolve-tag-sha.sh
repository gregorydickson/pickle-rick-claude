#!/usr/bin/env bash
# Shared tag -> commit sha resolution. Source this file; it defines
# list_tag_shas_from_listing / resolve_tag_sha and takes no action on its own.
#
# Extracted from verify-release-tag.sh (ticket e98d9866) so
# reconcile-release-tags.sh (ticket ae3296ab) can reuse the exact same
# deref logic instead of re-deriving it -- see CLAUDE.md's "enumerated set
# is a liability" guidance: two copies of "how to deref a tag" is the
# duplication shape it bans.
#
# list_tag_shas_from_listing <ls-remote-output>
#   Prints one `<tag><TAB><commit-sha>` line per tag present in an
#   ALREADY-FETCHED `git ls-remote` listing, in the listing's own order.
#   Takes NO action of its own -- pure text, no network, no git.
#
#   An annotated tag contributes two lines to a listing: the tag object's
#   own sha under `refs/tags/<tag>`, and the commit sha under
#   `refs/tags/<tag>^{}`. The tag object's sha is NOT the commit sha, so
#   the `^{}` line WINS whenever it is present. This function is the ONE
#   place that rule is expressed; every caller reads the sha from a
#   listing through it rather than re-deriving the peel.
list_tag_shas_from_listing() {
  printf '%s\n' "$1" | awk '
    $2 == "" { next }
    {
      ref = $2
      sub(/^refs\/tags\//, "", ref)
      # Suffix test by substring, not regex: `^`, `{` and `}` are all ERE
      # metacharacters and their escaping varies across awk implementations.
      len = length(ref)
      if (len > 3 && substr(ref, len - 2) == "^{}") {
        ref = substr(ref, 1, len - 3)
        peel[ref] = $1
      } else if (!(ref in bare)) {
        bare[ref] = $1
      }
      if (!(ref in seen)) { seen[ref] = 1; order[++n] = ref }
    }
    END {
      for (i = 1; i <= n; i++) {
        r = order[i]
        print r "\t" ((r in peel) ? peel[r] : bare[r])
      }
    }
  '
}

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
  local ls_remote_output actual_sha
  ls_remote_output="$(git ls-remote "$remote" "refs/tags/$tag" "refs/tags/$tag^{}")"

  if [ -z "$ls_remote_output" ]; then
    return 1
  fi

  actual_sha="$(list_tag_shas_from_listing "$ls_remote_output" \
    | awk -F'\t' -v want="$tag" '$1 == want { print $2; exit }')"

  if [ -z "$actual_sha" ]; then
    return 1
  fi

  printf '%s\n' "$actual_sha"
  return 0
}
