#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: yarn release:publish [--check] VERSION

Publish every Invokta package from an existing stable release tag directly to
the npm latest dist-tag. Publication requires GitHub Actions OIDC. The command
is state-aware and safely skips package versions already published from the
same release commit.

Options:
  --check   Run all read-only checks, build, and package dry-runs.
  -h, --help
            Show this help.

Examples:
  yarn release:publish --check 0.7.0
  yarn release:publish 0.7.0
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

npm_registry_url="https://registry.npmjs.org/"

npm_registry_command() {
  npm "$@" --registry="$npm_registry_url"
}

require_trusted_publishing_npm() {
  local npm_version major minor patch
  npm_version=$(npm --version)
  IFS='.' read -r major minor patch <<<"$npm_version"
  patch="${patch%%-*}"

  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] ||
    die "Could not parse npm version $npm_version"
  if ((major < 11 || (major == 11 && minor < 5) || (major == 11 && minor == 5 && patch < 1))); then
    die "npm $npm_version does not support trusted publishing; npm 11.5.1 or newer is required"
  fi
}

is_newer_stable_version() {
  node - "$1" "$2" <<'NODE'
const [candidate, target] = process.argv.slice(2);
const parse = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) process.exit(2);
  return match.slice(1).map(Number);
};
const left = parse(candidate);
const right = parse(target);
for (let index = 0; index < left.length; index += 1) {
  if (left[index] > right[index]) process.exit(0);
  if (left[index] < right[index]) process.exit(1);
}
process.exit(1);
NODE
}

wait_for_registry_field() {
  local package_spec="$1"
  local field="$2"
  local expected="$3"
  local actual=""

  for attempt in {1..12}; do
    if actual=$(npm_registry_command view "$package_spec" "$field" 2>/dev/null) &&
      [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    if ((attempt < 12)); then
      sleep 5
    fi
  done

  die "$package_spec $field is ${actual:-unavailable}, expected $expected"
}

check_only=false
version=""

while (($# > 0)); do
  case "$1" in
    --check)
      check_only=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      die "Unknown option: $1"
      ;;
    *)
      [[ -z "$version" ]] || die "Only one version may be supplied"
      version="${1#v}"
      ;;
  esac
  shift
done

[[ -n "$version" ]] || {
  usage >&2
  exit 2
}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "Version must use stable semantic versioning, for example 0.7.0"

for command_name in git npm yarn node awk; do
  require_command "$command_name"
done

script_directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(git -C "$script_directory" rev-parse --show-toplevel 2>/dev/null) ||
  die "The script must remain inside the Invokta repository"
cd "$repository_root"

# shellcheck source=./package-set.sh
source "$script_directory/package-set.sh"

tag="v$version"

log "Checking Git release state"
git fetch --quiet origin --prune --tags

[[ -z "$(git status --porcelain --untracked-files=normal)" ]] ||
  die "The working tree must be clean"
[[ "$(git cat-file -t "$tag" 2>/dev/null || true)" == "tag" ]] ||
  die "$tag must exist as an annotated tag"

tag_commit=$(git rev-list -n 1 "$tag")
head_commit=$(git rev-parse HEAD)
[[ "$head_commit" == "$tag_commit" ]] ||
  die "HEAD must point to $tag ($tag_commit)"
git merge-base --is-ancestor "$tag_commit" origin/main ||
  die "$tag is not contained in origin/main"

remote_tag_object=$(
  git ls-remote --tags origin "refs/tags/$tag" |
    awk -F '\t' 'NR == 1 { print $1 }'
)
remote_tag_commit=$(
  git ls-remote --tags origin "refs/tags/$tag^{}" |
    awk -F '\t' 'NR == 1 { print $1 }'
)
[[ -n "$remote_tag_object" && -n "$remote_tag_commit" ]] ||
  die "The remote $tag must be an annotated tag"
[[ "$remote_tag_commit" == "$tag_commit" ]] ||
  die "The remote $tag resolves to $remote_tag_commit, expected $tag_commit"

root_version=$(node -p "require('./package.json').version")
[[ "$root_version" == "$version" ]] ||
  die "Root package version is $root_version, expected $version"

for entry in "${release_package_entries[@]}"; do
  IFS='|' read -r package_directory expected_name <<<"$entry"
  manifest_name=$(node -p "require('./$package_directory/package.json').name")
  manifest_version=$(node -p "require('./$package_directory/package.json').version")
  [[ "$manifest_name" == "$expected_name" ]] ||
    die "$package_directory is named $manifest_name, expected $expected_name"
  [[ "$manifest_version" == "$version" ]] ||
    die "$manifest_name is version $manifest_version, expected $version"
done

log "Checking npm registry"
registry=$(npm_registry_command config get registry)
[[ "$registry" == "$npm_registry_url" ]] ||
  die "npm registry is $registry, expected $npm_registry_url"
npm_registry_command ping >/dev/null

pending_entries=()
published_entries=()

for entry in "${release_package_entries[@]}"; do
  IFS='|' read -r package_directory package_name <<<"$entry"
  latest_version=$(npm_registry_command view "$package_name" dist-tags.latest 2>/dev/null) ||
    die "$package_name has no readable latest dist-tag"
  [[ "$latest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "$package_name latest is not a stable semantic version: $latest_version"
  if is_newer_stable_version "$latest_version" "$version"; then
    die "$package_name latest is $latest_version, which is newer than $version"
  fi

  if registry_output=$(npm_registry_command view "$package_name@$version" version 2>&1); then
    registry_git_head=$(npm_registry_command view "$package_name@$version" gitHead)
    [[ "$registry_git_head" == "$tag_commit" ]] ||
      die "$package_name@$version already exists with gitHead $registry_git_head"
    [[ "$latest_version" == "$version" ]] ||
      die "$package_name@$version exists but latest is $latest_version; trusted publishing cannot change dist-tags"
    printf 'Present: %s@%s (matching gitHead)\n' "$package_name" "$version"
    published_entries+=("$entry")
  elif [[ "$registry_output" == *"E404"* ]]; then
    printf 'Pending: %s@%s; current latest=%s\n' "$package_name" "$version" "$latest_version"
    pending_entries+=("$entry")
  else
    printf '%s\n' "$registry_output" >&2
    die "Could not determine whether $package_name@$version exists"
  fi
done

log "Building the tagged source"
yarn install --frozen-lockfile --non-interactive
yarn build

log "Checking package contents"
bash "$script_directory/check-packages.sh"

if [[ "$check_only" == true ]]; then
  printf '\nPreflight passed for %s. No registry changes were made.\n' "$tag"
  printf 'Pending packages: %d; already published from this tag: %d.\n' \
    "${#pending_entries[@]}" "${#published_entries[@]}"
  exit 0
fi

[[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] ||
  die "GitHub Actions OIDC is unavailable: ACTIONS_ID_TOKEN_REQUEST_URL is missing"
[[ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] ||
  die "GitHub Actions OIDC is unavailable: ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing"
require_trusted_publishing_npm

for entry in "${pending_entries[@]}"; do
  IFS='|' read -r package_directory package_name <<<"$entry"
  log "Publishing $package_name@$version directly to latest"
  npm_registry_command publish "./$package_directory" --access public --tag latest
  wait_for_registry_field "$package_name@$version" version "$version"
  wait_for_registry_field "$package_name@$version" gitHead "$tag_commit"
done

log "Verifying latest dist-tags"
for entry in "${release_package_entries[@]}"; do
  IFS='|' read -r _ package_name <<<"$entry"
  wait_for_registry_field "$package_name" dist-tags.latest "$version"
  printf '%s latest -> %s\n' "$package_name" "$version"
done

printf '\nPublished %s directly to latest successfully.\n' "$tag"
