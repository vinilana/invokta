#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: yarn release:create-tag VERSION

Create and push the annotated tag that starts the protected release workflow.
The workflow publishes the packages before it creates the GitHub Release.

Examples:
  yarn release:create-tag 0.7.0
  yarn release:create-tag v0.7.0
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

[[ $# -eq 1 ]] || {
  usage >&2
  exit 2
}

case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  --*)
    die "Unknown option: $1"
    ;;
esac

version="${1#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "Version must use stable semantic versioning, for example 0.7.0"

for command_name in git node awk; do
  require_command "$command_name"
done

script_directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(git -C "$script_directory" rev-parse --show-toplevel 2>/dev/null) ||
  die "The script must remain inside the Invokta repository"
cd "$repository_root"

tag="v$version"

log "Checking release state"
git fetch --quiet origin --prune --tags

[[ -z "$(git status --porcelain --untracked-files=normal)" ]] ||
  die "The working tree must be clean"

head_commit=$(git rev-parse HEAD)
main_commit=$(git rev-parse refs/remotes/origin/main 2>/dev/null) ||
  die "origin/main is not available"
[[ "$head_commit" == "$main_commit" ]] ||
  die "HEAD must match origin/main ($main_commit)"

root_version=$(node -p "require('./package.json').version")
[[ "$root_version" == "$version" ]] ||
  die "Root package version is $root_version, expected $version"

local_tag_type=$(git cat-file -t "$tag" 2>/dev/null || true)
if [[ -n "$local_tag_type" && "$local_tag_type" != "tag" ]]; then
  die "$tag exists but is not an annotated tag"
fi

if [[ "$local_tag_type" == "tag" ]]; then
  local_tag_commit=$(git rev-parse "$tag^{commit}")
  [[ "$local_tag_commit" == "$head_commit" ]] ||
    die "$tag points to $local_tag_commit, expected $head_commit"
fi

remote_tag_object=$(
  git ls-remote --tags origin "refs/tags/$tag" |
    awk -F '\t' 'NR == 1 { print $1 }'
)
remote_tag_commit=$(
  git ls-remote --tags origin "refs/tags/$tag^{}" |
    awk -F '\t' 'NR == 1 { print $1 }'
)

if [[ -n "$remote_tag_object" ]]; then
  [[ -n "$remote_tag_commit" ]] ||
    die "origin/$tag exists but is not an annotated tag"
  [[ "$remote_tag_commit" == "$head_commit" ]] ||
    die "origin/$tag points to $remote_tag_commit, expected $head_commit"

  local_tag_object=$(git rev-parse "$tag")
  [[ "$local_tag_object" == "$remote_tag_object" ]] ||
    die "Local and remote $tag tag objects do not match"

  printf '%s already exists on origin at %s.\n' "$tag" "$head_commit"
  printf 'Rerun its GitHub Actions workflow if publication needs to resume.\n'
  exit 0
fi

printf '\nThis will push annotated tag %s from commit %s.\n' "$tag" "$head_commit"
read -r -p "Type $tag to continue: " confirmation
[[ "$confirmation" == "$tag" ]] || die "Tag creation cancelled"

if [[ -z "$local_tag_type" ]]; then
  log "Creating annotated tag $tag"
  git tag -a "$tag" "$head_commit" -m "Invokta $version"
fi

log "Pushing annotated tag $tag"
git push --quiet origin "refs/tags/$tag:refs/tags/$tag"

remote_tag_commit=$(
  git ls-remote --tags origin "refs/tags/$tag^{}" |
    awk -F '\t' 'NR == 1 { print $1 }'
)
[[ "$remote_tag_commit" == "$head_commit" ]] ||
  die "The pushed $tag does not resolve to $head_commit on origin"

printf '\nPushed %s. The protected release workflow will publish it.\n' "$tag"
