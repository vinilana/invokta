# ADR 0034: Harness configuration variants and VS Code remote user scope

- Status: Accepted
- Date: 2026-08-22

## Context

ADR 0013 limited installer mutation to one default user configuration per
target. That assumption is incomplete for two supported harnesses.

Antigravity installations in the field use both
`~/.gemini/config/mcp_config.json` and the established
`~/.gemini/antigravity/mcp_config.json`. A stale empty file can exist at one
location while the harness reads a populated file at the other. Selecting only
the first path either rejects the empty JSON or installs into a file the active
harness does not read.

VS Code exposes its `code` launcher inside WSL, Remote SSH, and other remote
extension hosts through an exact server-side `remote-cli/code` path. Treating
that launcher as a native Linux desktop writes `~/.config/Code/User/mcp.json`,
while the remote VS Code server reads its own `data/User/mcp.json`. The
installer then reports an owned installation that the active client cannot
observe.

Both defects concern target selection before a confirmed transaction. They do
not require client execution, configuration-content discovery, networking, or
another capability execution path.

## Decision

The Antigravity target recognizes exactly two home-confined global candidates,
in this order:

1. `~/.gemini/config/mcp_config.json`;
2. `~/.gemini/antigravity/mcp_config.json`.

Detection inspects path identity and file size but does not read configuration
contents. One populated safe file is selected. Two populated files fail closed
as `HARNESS_CONFIG_AMBIGUOUS`. A zero-byte candidate is an initializable
placeholder: it does not override one populated sibling, and the Antigravity
adapter treats a selected zero-byte file as an absent server collection. When
neither candidate exists, the first path remains the creation default.

The VS Code target recognizes a remote user scope only when the resolved `code`
executable has one of these exact home-confined shapes:

```text
~/.vscode-server/bin/<commit>/bin/remote-cli/code
~/.vscode-server-insiders/bin/<commit>/bin/remote-cli/code
```

The selected configuration is the corresponding
`<server-root>/data/User/mcp.json`. Other launchers keep the existing native
Linux or macOS default. Native Windows VS Code mutation remains unsupported.
The installer does not infer Windows host paths, cross the home boundary, scan
profiles, or execute `code` to ask it for state.

A confirmed install relocates an existing managed entry when the same engine
ID and target ID are recorded at a different safe configuration path. It first
removes the exactly matching owned definition and state record through the old
path's normal transaction, then installs through the newly detected path's
normal transaction. Drift, conflict, an unsafe path, or an invalid old record
fails closed. The two path transactions are ordered but not globally atomic;
if the second fails after removal, repeating the install resumes from a clean
uninstalled state. No relocation occurs before confirmation.

This decision is a narrow exception to ADR 0013's exclusion of remote-workspace
scope. It supports only the VS Code server's default remote **user**
configuration proven by its launcher identity. Project, workspace, named
profile, arbitrary remote, and organization-managed scopes remain unsupported.
The public command surface, error codes, state schema, target IDs, adapter
formats, and exit statuses are unchanged.

## Consequences

- Antigravity installations select the active established global file without
  overwriting two populated variants or interpreting configuration contents.
- VS Code launched through its remote CLI receives a server-side definition
  whose absolute Node and engine paths remain executable in that environment.
- Existing managed entries created at a formerly selected path are repaired by
  the next confirmed install and remain unavailable to ordinary management
  until then.
- Target probing receives already captured executable evidence; this is an
  internal port extension and performs no new process or network I/O.
- Supporting another harness variant or remote scope still requires a finite,
  documented path contract and equivalent ownership, ambiguity, migration, and
  transaction evidence.
