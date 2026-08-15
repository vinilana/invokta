# ADR 0032: CLI installation inspection and homologation

- Status: Accepted
- Date: 2026-08-15

## Context

ADR 0021 and ADR 0028 give an engine author a workspace Playground: `serve`
loads an explicitly named built module and can emulate the CLI adapter by
spawning a devtools-owned child that imports that module. ADR 0030 can point
the same Playground at a project entry point. Those modes are composition-root
emulation. They require a workspace, they can mint development principals, and
they are presented as adapter chips next to `direct`, `mcp-stdio`, and
`mcp-http`.

Testing an installed CLI is a different use case. A developer or release
reviewer needs to validate the same executable, argument prefix, working
directory, and environment an operator will type, without importing the
engine's workspace or claiming knowledge of its module graph. Reusing `serve`'s
adapter-runner prevents this: that runner imports a loaded module, injects a
devtools principal, and never exercises the installed binary as shipped.
Requiring an engine module makes installed-CLI homologation impossible.

ADR 0022 already solved the peer problem for MCP. Bare `invokta-devtools` and
`open` start an idle MCP workbench; the user connects exactly one launch
descriptor or URL. The CLI deserves the same inspection surface, not another
Playground chip. Folding the two into one session, or auto-running `run`
while listing the catalog, would exceed the supporting-tool boundary and
create unsafe side effects. The installed CLI, not the workbench, remains
the composition root that supplies `principal` (ADR 0005). Actor or login
flags are not a framework CLI contract.

## Decision

`@invokta/devtools` adds a CLI installation inspection and homologation mode
as a peer of the MCP attach workbench. Running
`invokta-devtools open --cli` starts an idle web workbench on loopback.
`--cli` is an `open` option and may appear with `--port`. Bare
`invokta-devtools` and `open` without `--cli` remain the idle MCP workbench
chartered by ADR 0022. This decision does not amend ADR 0022 except to
record that `open --cli` is a sibling command.

Startup performs no workspace load, network request, process spawn,
discovery, or configuration import. The generated `yarn devtools` script
remains `serve`. The workbench MUST NOT reuse the `serve` adapter-runner.

The user must explicitly connect exactly one target: a structured process
descriptor containing an executable, an argument array, an optional working
directory, and environment configuration. The executable is started directly
with `shell: false`. There is no HTTP CLI target and no OAuth path.

Connect runs exactly `<command> <args...> list` once, waits for the child to
exit, and parses one Invokta `list` JSON document from stdout. Refresh
repeats that `list` only. Selecting a capability runs
`<command> <args...> describe <capability-id>` once (read-only); that child
exits. `run` runs only when the user presses Run, as
`<command> <args...> run <capability-id> --input <json>`. Connect, Refresh,
and Describe MUST NOT spawn `run`. The workbench MUST NOT pass `--stdin`,
`--format`, actor flags, login flags, or any option the published CLI
contract does not use for that verb. Every verb uses the same connected
descriptor, including its environment.

A non-zero `list` exit, a spawn failure, a deadline miss, an oversized
stream, or a stdout document that is not Invokta `list` JSON fails closed
and leaves the workbench disconnected. Equality with a byte or count limit
is accepted. There is no automatic retry.

Invokta `list` JSON is the canonical CLI serialization of `engine.list()`:
one JSON value, an array of capability summaries. Each element MUST be an
object with a non-empty string `id` and a string `description`; `title` and
`annotations`, when present, MUST match `CapabilitySummary` from
`@invokta/core`.

Additional properties on a well-typed `list` element are ignored. Unknown
keys never fail Connect. An empty array is a valid catalog (zero Commands,
session connected). Duplicate `id`s are accepted in document order; the
workbench does not merge or reject them. Selecting an id runs `describe` /
`run` with that id string once. `description` MAY be the empty string.
`id` MUST be a non-empty string. `title`, when present, MUST be a string.
`annotations`, when present, MUST be an object whose known keys are only
`readOnly`, `destructive`, `idempotent`, and `openWorld`, each a boolean
when present; unknown annotation keys are ignored. A mistyped `title` or
`annotations` fails closed.

Stdout MUST decode as UTF-8. The entire stdout MUST parse as exactly one
JSON value. Pretty-printed official `format: "human"` JSON of a valid
catalog is accepted. A trailing newline or other JSON-whitespace is
accepted. Any non-whitespace suffix, a second JSON value, or a UTF-8
decode failure fails closed. A non-zero `list` exit fails closed even if
stdout is valid catalog JSON. Non-empty stderr with exit 0 and a valid
catalog does not fail Connect. Stderr is still bounded at 10 MiB and MUST
NOT appear in Activity or API bodies.

Selecting a listed id succeeds only when exit is 0 and stdout is exactly
one UTF-8 JSON object such that:

- `id` is a non-empty string;
- `description` is a string (empty allowed);
- `inputSchema` and `outputSchema` are objects (not arrays, not null);
- `title` / `annotations` follow the `list` rules above when present;
- `timeoutMs`, when present, is a finite number;
- additional properties are ignored.

Any other document, non-zero exit, timeout, oversize stream, or spawn
failure fails the selection only: the session stays connected, the last
successful catalog remains, no schema is invented, and `run` is not
spawned. Pretty-printed official `describe` JSON is accepted under the
same “one JSON value” rule as `list`.

Run is enabled only after a successful Connect/`list` and a successful
`describe` for the selected id. A failed `run` (non-zero exit, spawn
failure, deadline, oversize stream, non-JSON or invalid result document)
records Activity and keeps the session connected. It MUST NOT clear the
catalog or require a new Connect. A failed Refresh (`list`) follows the
Connect `list` rule: disconnected, no catalog, no automatic `describe` /
`run`. Disconnect while a verb is in flight MUST terminate that child and
leave the workbench disconnected. There is no user-facing cancel that
stays connected.

`command` is passed to `spawn` as given; resolution is Node’s `shell:
false` PATH / `cwd` rules. The workbench MUST NOT search the project tree
or rewrite the executable. Child environment is the same composition ADR
0022 / the MCP stdio client already use for attach: a local allowlist
matching the MCP SDK `getDefaultEnvironment` (HOME, LOGNAME, PATH, SHELL,
TERM, USER on unix; APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH,
PROCESSOR_ARCHITECTURE, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME,
USERPROFILE, PROGRAMFILES on win32; values starting with `()` are
skipped), plus the configured overlay. The host process environment MUST
NOT be copied wholesale (no `...process.env`). Configured names from the
descriptor MUST be present. Overlay values override defaults of the same
name. Working directory is the optional `cwd` as given, or the child’s
default when omitted. No `serve`-style confinement to a project directory
(ADR 0030 does not apply). `shell` is always `false`. The workbench MUST
NOT import the MCP SDK, `@invokta/cli`, or the target module in order to
list, describe, or run.

stdin is `'ignore'` (or an immediately ended stream). The workbench never
writes stdin and never passes `--stdin`. stdout and stderr are pipes,
each hard-capped at 10 MiB.

The attached CLI workbench exposes only Commands, Activity, and Connection
validation. It MUST NOT expose or imply engine Doctor results, development
principals, workspace watch state, core events, or an `engine.invoke` trace.
Its interface remains a compact developer tool, uses the Invokta visual
identity, and does not use bracketed decorative labels. An in-session switch
between the MCP and CLI workbenches is out of scope.

Credentials follow the MCP stdio environment rules in ADR 0022. Names MUST
match `^[A-Za-z_][A-Za-z0-9_]*$`, MUST be unique, and MUST NOT be empty.
Values MUST NOT be empty and MUST NOT be accepted as literal command
arguments. Values entered in the interface exist in browser memory only
until a connection response arrives, then the fields are cleared and
replaced by a masked configured state; the active connection keeps only its
process-memory copy. Values are never returned by an API or written to
browser storage. Connection secrets never appear in diagnostics, Activity
records, or server responses.

Each verb is a new child with `shell: false`. The workbench keeps no warm
process and no adapter session between verbs. It permits one connected
target and one explicit verb at a time. A verb settles when the child exits
or the deadline expires. A child that outlives its deadline fails closed;
the workbench MUST terminate that child (SIGTERM, then SIGKILL after a
short grace). It does not promise descendant-process cleanup or exact
operating-system process-reap timing beyond that termination.

Limits parallel ADR 0022 unless the CLI process contract differs:

| Limit | Value | Parallel or CLI-specific |
| --- | --- | --- |
| `list` / Connect / Refresh deadline | 15 seconds | Catalog collection in ADR 0022 |
| `describe` deadline | 15 seconds | CLI-specific verb; read-only like catalog collection, not a domain `run` |
| `run` deadline | 60 seconds | Manual tool call in ADR 0022 |
| Each child stdout | 10 MiB | MCP message / catalog / response |
| Each child stderr | 10 MiB | CLI-specific second stream; MCP has no sibling stderr catalog |
| Capability catalog | 2,000 summaries | 2,000 tools in ADR 0022 |
| Catalog pages | Not applicable | CLI `list` is one JSON document, not a paginated protocol |
| `--input` argument | 98,304 UTF-8 bytes | CLI-specific; stays below the common 128 KiB per-argument OS ceiling. Crossing fails closed before spawn. The 10 MiB bound does not apply to argv. |
| Activity | 500 metadata records | ADR 0022 |
| Displayed capability id or title | 256 Unicode code points | Displayed tool name in ADR 0022 |
| Browser sessions | 128 in process memory | ADR 0022 |
| Connection-descriptor request body | 1 MiB | MCP attach connection POST |
| Run request body (editor JSON) | 10 MiB | MCP attach call POST; the spawned `--input` argument is still bound to 98,304 bytes |

Activity drops its oldest record when a new record would cross its capacity.
Activity records verbs, timing, outcome, exit code, and a truncated
capability id. It MUST NOT store argv values, environment values, or stream
bodies. Creating another browser session evicts the oldest-created session
that does not own the active target.

The closed `AttachedCliSessionErrorCode` set is:

`INVALID_TARGET`, `SPAWN_FAILED`, `CONNECTION_FAILED`, `PROTOCOL_ERROR`,
`TIMEOUT`, `LIMIT_EXCEEDED`, `TARGET_BUSY`, `NOT_CONNECTED`,
`ENVIRONMENT_VALUE_MISSING`.

Messages are stable, stack-free, and MUST NOT interpolate env values, argv
values, or stream bodies. No automatic retry for any code.

Connection-mutating browser requests require the exact loopback `Host`, the
exact interface `Origin`, and a process-memory CSRF token bound to the
browser session. The interface emits a restrictive Content Security Policy
and no CORS headers. The workbench MUST bind only loopback. It MUST NOT
write to the developer's project, persist connections or credentials,
discover executables, import client configuration, or load the target as a
module.

A non-interactive `verify --cli` is out of scope.

The existing commands remain compatible:

- `doctor <module>` and `serve <module>` keep their ADR 0021 behavior;
- bare `invokta-devtools` and `open` keep their ADR 0022 MCP behavior;
- `verify` remains MCP-only;
- adding `--cli` requires release notes, but no existing valid invocation
  changes meaning.

## Consequences

- A developer can inspect a local installed Invokta CLI without an Invokta
  workspace or engine module.
- Installed-target inspection validates launch, the `list` / `describe` /
  `run` process contract, and the advertised capability catalog. It does not
  prove that a `package.json` script or another client's wrapper contains
  the same descriptor.
- `open --cli` is a sibling of ADR 0022's idle MCP workbench. ADR 0022 is
  not otherwise amended; a one-sentence sibling note in its consequences
  records the peer command.
- The same-deliverable charter update adds AE-LIMIT-07, the AE-SCOPE-01
  package-row wording, the concurrent-verb limit wording, and
  `AE-DEVTOOLS-ATTACH-CLI-01..15`.
- The workbench gains process-spawn authority only after an explicit
  Connect, Refresh, Describe, or Run. Idle startup remains inert.
- Devtools does not take a new package dependency for this mode. It MUST
  NOT import `@invokta/cli` or the target module in order to list, describe,
  or run. The published CLI child remains the only execution path, and that
  child remains bound by ADR 0005.
- Generated `yarn devtools` continues to start `serve`, so authors keep the
  workspace Playground by default.
- Adding `verify --cli`, an in-session MCP↔CLI switch, persistence, target
  discovery, configuration import, multiple targets, automatic `run`,
  actor or login flags, or a warm CLI process requires another
  architectural decision.
