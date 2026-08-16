#!/usr/bin/env bash

# The manifest order preserves internal dependency availability during publish.
release_manifest_directory=$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)
if ! release_package_output=$(
  node "$release_manifest_directory/release-packages.mjs" shell-entries
); then
  printf 'Error: Could not load the release package manifest\n' >&2
  return 1 2>/dev/null || exit 1
fi

release_package_entries=()
while IFS= read -r release_package_entry; do
  [[ -n "$release_package_entry" ]] &&
    release_package_entries+=("$release_package_entry")
done <<<"$release_package_output"

if ((${#release_package_entries[@]} == 0)); then
  printf 'Error: The release package manifest is empty\n' >&2
  return 1 2>/dev/null || exit 1
fi

readonly -a release_package_entries
unset release_manifest_directory release_package_entry release_package_output
