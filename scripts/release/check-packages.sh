#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

for command_name in git node npm; do
  require_command "$command_name"
done

script_directory=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(git -C "$script_directory" rev-parse --show-toplevel 2>/dev/null) ||
  die "The script must remain inside the Invokta repository"
cd "$repository_root"

# shellcheck source=./package-set.sh
source "$script_directory/package-set.sh"

root_version=$(node -p "require('./package.json').version")

for entry in "${release_package_entries[@]}"; do
  IFS='|' read -r package_directory expected_name <<<"$entry"
  manifest_name=$(node -p "require('./$package_directory/package.json').name")
  manifest_version=$(node -p "require('./$package_directory/package.json').version")
  [[ "$manifest_name" == "$expected_name" ]] ||
    die "$package_directory is named $manifest_name, expected $expected_name"
  [[ "$manifest_version" == "$root_version" ]] ||
    die "$manifest_name is version $manifest_version, expected $root_version"

  printf 'Dry run: %s@%s\n' "$manifest_name" "$manifest_version"
  npm pack --dry-run "./$package_directory" >/dev/null
done

printf 'Package dry-runs passed for Invokta %s.\n' "$root_version"
