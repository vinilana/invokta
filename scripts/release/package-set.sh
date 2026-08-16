#!/usr/bin/env bash

# The order preserves exact internal dependency availability during publication.
release_package_entries=(
  "packages/core|@invokta/core"
  "packages/cli|@invokta/cli"
  "packages/mcp|@invokta/mcp"
  "packages/tooling|@invokta/tooling"
  "packages/installer|@invokta/installer"
  "packages/deploy|@invokta/deploy"
  "packages/devtools|@invokta/devtools"
  "packages/create-invokta-engine|create-invokta-engine"
  "packages/create-invokta-capability|create-invokta-capability"
  "packages/create-invokta-capability-library|create-invokta-capability-library"
)

readonly -a release_package_entries
