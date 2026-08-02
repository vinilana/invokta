#!/usr/bin/env bash
# Runs the console against a throwaway HOME so install, enable, disable, and
# remove can be exercised without touching the real client configurations.
#
# Usage: apps/manager-poc/scripts/sandbox.sh [--no-open]

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/invokta-manager-sandbox-XXXXXX")"

mkdir -p \
  "$sandbox/.cursor" \
  "$sandbox/.codex" \
  "$sandbox/.config/Code/User" \
  "$sandbox/projects/demo-engine/dist"

cat > "$sandbox/.cursor/mcp.json" <<'JSON'
{
  "mcpServers": {
    "unrelated-server": { "command": "true", "args": [] }
  }
}
JSON

cat > "$sandbox/.config/Code/User/mcp.json" <<'JSON'
{
  "servers": {}
}
JSON

cat > "$sandbox/.codex/config.toml" <<'TOML'
model = "gpt-5"

[mcp_servers.unrelated-server]
command = "true"
args = []
TOML

cat > "$sandbox/projects/demo-engine/invokta.mcp.json" <<'JSON'
{
  "schemaVersion": 1,
  "id": "demo-engine",
  "version": "1.0.0",
  "title": "Demo Engine",
  "description": "Sandbox fixture for the manager proof of concept.",
  "capabilityIds": ["demo.ping"],
  "server": {
    "name": "demo-engine",
    "entrypoint": "dist/mcp-stdio.js",
    "forwardEnv": []
  }
}
JSON

printf 'process.exit(0);\n' > "$sandbox/projects/demo-engine/dist/mcp-stdio.js"

echo "Sandbox HOME: $sandbox"
echo "Inspect the fixtures afterwards, then delete the directory."
echo

exec env HOME="$sandbox" XDG_STATE_HOME="$sandbox/.local/state" \
  node "$root/apps/manager-poc/bin/invokta-manager.mjs" \
  --scan "$sandbox/projects" "$@"
