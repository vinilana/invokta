# Local capability MCP installer

- Status: Draft
- Target: Post-v0.1
- Change type: Additive end-user package and CLI
- Date: 2026-07-28

## Summary

AI Engine users need one local interface that can find supported AI harnesses on
their machine and make an engine's MCP server available to those harnesses. The
installer provides an interactive terminal UI backed by a versioned local
registry. A user selects an installable capability bundle, selects one or more
detected harnesses, reviews the exact configuration files that will change, and
then installs, enables, or disables the bundle.

For this release, installation means configuration only. The installer writes an
MCP server definition into the harness's standard user configuration file. It
does not download packages, clone repositories, run package managers, start MCP
servers, probe endpoints, perform OAuth, or execute capabilities.

The atomic installation unit is one registry entry backed by one MCP server. The
server may expose one or more AI Engine capability IDs. Because MCP client
configuration is server-scoped, the installer enables and disables the whole
entry; it does not claim to toggle individual MCP tools within a multi-capability
server.

The first supported harness adapters are Codex, Hermes Agent, and OpenClaw. The
adapter boundary is intentionally finite and explicit. The installer does not
guess configuration shapes for unknown agents.

## Relationship to the existing architecture

This specification is a post-v0.1 expansion. It does not change the v0.1
framework contract, the three v0.1 packages, the five required capability
fields, the seven-code `EngineError` taxonomy, or any execution adapter.

The installer is an external configuration application:

- it does not import or execute `CapabilityDefinition`, `Engine`, or
  `engine.invoke`;
- it never calls a capability handler and does not create another capability
  execution path;
- it configures an engine only through the MCP server boundary already owned by
  `@ai-engine/mcp`;
- it does not add a registry, discovery service, plugin loader, or mutable state
  to `@ai-engine/core`;
- it does not discover ESM exports or compose capabilities inside an engine;
- it does not change the responsibility of `@ai-engine/cli`, whose commands
  continue to execute capabilities only through `engine.invoke`.

The local installation registry described here is a catalog of MCP launch or
connection descriptors. It is not the runtime package registry, community
library discovery, or hot capability composition deferred by ADR 0001 and the
capability composition specification.

Implementation requires a new ADR before code is added. That ADR must authorize
the post-v0.1 `@ai-engine/installer` package, amend the package boundary in ADR
0004, and distinguish the end-user installer from the dev-only
`@ai-engine/tooling` package authorized by ADR 0009. The preferred package and
binary are:

| Artifact | Responsibility |
| --- | --- |
| `packages/installer` / `@ai-engine/installer` | Registry validation, harness detection, safe configuration mutation, state, and interactive UI |
| `ai-engine-installer` | Interactive executable; owns no capability execution command |

No existing runtime or tooling package may depend on the installer. The
installer may use format-preserving configuration libraries and Node built-ins,
but it must not depend on `@ai-engine/core`, `@ai-engine/cli`,
`@ai-engine/mcp`, or `@ai-engine/tooling`.

## Goals

1. Detect the supported AI harnesses installed for the current user.
2. Present one interactive inventory of locally registered capability bundles.
3. Install an entry by adding its MCP server to one or more harness user
   configurations.
4. Enable or disable an installer-managed entry without losing its MCP
   definition.
5. Preserve unrelated harness configuration, comments, formatting, file mode,
   and ownership.
6. Refuse ambiguous overwrites and manual configuration drift.
7. Keep secret values out of the registry, state file, preview, diagnostics, and
   logs.
8. Make every mutation deterministic, idempotent, and independently testable
   without a real harness installation.
9. Add future harnesses through explicit adapters without changing the registry
   model or the framework core.

## Non-goals

- Downloading, cloning, building, or updating an engine or MCP server.
- Running `npm`, `npx`, `pip`, `uv`, `docker`, a shell, or a registry-supplied
  command during installation.
- A remote registry, marketplace, search service, or registry synchronization.
- Installing capability libraries into an engine or changing
  `createEngine` composition.
- Starting an MCP server, opening an MCP connection, listing tools, or verifying
  endpoint health.
- OAuth login, token storage, secret prompting, or credential management.
- Enabling or disabling individual tools within one MCP server.
- Project, workspace, profile, system, enterprise-managed, or remote-machine
  configuration scopes.
- Native Windows support in the first release. WSL is treated as Linux.
- Generic discovery of arbitrary agents or inference from configuration file
  names.
- Replacing, deleting, or adopting a conflicting user-owned MCP definition.
- Uninstalling an entry or automatically upgrading a previously installed
  descriptor.
- A non-interactive mutation command or machine-readable mutation API.

## Terminology

**Installable capability bundle**
: One registry entry with a stable installer ID, display metadata, declared AI
  Engine capability IDs, and exactly one MCP server descriptor. It is the atomic
  unit of installation and enablement.

**Local registry**
: The read-only, versioned JSON document shipped in the installed package. It is
  loaded from local disk and never refreshed over the network at runtime.

**Harness**
: A supported local AI or coding-agent application that acts as an MCP client.
  The first adapters are `codex`, `hermes`, and `openclaw`.

**Harness adapter**
: Installer-owned code that resolves one harness's standard configuration,
  reads and patches its format, maps the canonical MCP descriptor, and reports
  a reload hint. Adapters are not framework adapters and never invoke an engine.

**Managed installation**
: A harness MCP entry first written or explicitly adopted by the installer and
  recorded in installer state with a normalized definition fingerprint.

**External entry**
: A harness MCP entry whose server name exists but has no installer ownership
  record.

**Drift**
: A managed harness MCP definition whose normalized transport fields no longer
  match the fingerprint recorded when the installer last adopted or wrote it.
  The harness's native enabled or disabled field is excluded from this
  fingerprint.

## User-facing CLI

### Commands

The public command surface is deliberately small:

```text
ai-engine-installer
ai-engine-installer --help
ai-engine-installer --version
```

Running without arguments starts the interactive interface. Any other argument
is invalid usage. The first release has no hidden non-interactive mutation mode.

The command MUST require an interactive input terminal and output terminal.
When either is unavailable, it MUST fail without reading or writing registry,
state, or harness configuration.

### Primary flow

The interface MUST perform these steps in order:

1. validate the bundled registry;
2. detect every supported harness and inspect any safe, parseable user config;
3. show registry entries in deterministic `title`, then `id`, order;
4. let the user select one entry;
5. show each detected harness and the entry's current status there;
6. offer only actions valid for the selected status;
7. let the user select one or more eligible harnesses;
8. preflight every selected target without writing;
9. show the action, server name, target config paths, required executable, and
   required environment variable names;
10. require an explicit confirmation whose default is cancel;
11. apply each selected harness mutation and report its independent result;
12. show the adapter-specific reload or restart hint for every successful
    target.

The preview MUST NOT show environment variable values, existing config content,
HTTP credential values, installer state content, or a serialized whole MCP
entry.

### Status model

The UI uses these stable statuses for a registry entry in one harness:

| Status | Meaning | Available action |
| --- | --- | --- |
| `available` | No MCP entry exists for the registry server name. | Install |
| `enabled` | The installer manages a matching entry and the harness treats it as enabled. | Disable |
| `disabled` | The installer manages a matching entry and the harness treats it as disabled. | Enable |
| `external` | A structurally matching entry exists without installer ownership. | Adopt |
| `conflict` | An external entry uses the same server name with a different definition. | None |
| `drifted` | A managed entry differs from the last applied definition. | None |
| `outdated` | A managed, non-drifted entry matches its recorded definition, but the bundled registry now describes a different definition. | Enable or disable only |
| `invalid-config` | The target config cannot be safely parsed or patched. | None |

Adoption MUST be available only when the external entry's normalized definition
equals the current registry definition. Adoption writes installer state but does
not rewrite the harness config. A conflicting definition cannot be adopted or
replaced in this release.

An omitted native enablement field means enabled when that is the documented
harness default. On the first successful installer mutation, the adapter writes
an explicit native boolean so subsequent state is unambiguous.

### Exit codes and cancellation

| Exit code | Meaning |
| --- | --- |
| `0` | The user exited without requesting a mutation, cancelled before writing, or every requested target succeeded. |
| `1` | At least one requested target failed, including a partial multi-target result. |
| `2` | Invalid usage, no TTY, invalid registry, or installer initialization failure. |
| `130` | `SIGINT` cancelled the operation after the interactive interface started. |

`Escape`, `q`, and a negative confirmation return to the previous screen or exit
without writing. `SIGINT` before a target commit writes nothing. A signal that
arrives during an atomic file replacement is observed immediately after that
critical section; the installer MUST finish or roll back that one target before
exiting. Successful earlier targets in a multi-target operation remain applied
and appear in the final summary.

## Supported platforms and harnesses

### Platform scope

The first release supports Linux, macOS, and WSL. Harness configuration targets
must remain under the current user's home directory. Installer state may use an
absolute, current-user-owned `XDG_STATE_HOME`. The installer never requests
elevation and never writes a system or another user's configuration. Native
Windows paths, ACL behavior, and atomic replacement semantics require a later
specification update and acceptance fixtures.

The current user's home directory MUST come from the injected operating-system
home resolver. The implementation MUST NOT construct it by reading a shell or
executing `echo`, `env`, or another process.

### Detection

A harness is `installed` only when one of its adapter-declared executable names
resolves through the installer's inherited `PATH` to an executable regular file.
Resolution MUST be implemented without a shell and MUST not execute the harness,
including with `--version`.

When the standard config exists but no executable resolves, the UI shows the
harness as `configuration only`; it is not eligible for mutation. A stale config
is not proof that the harness remains installed. When the executable resolves
and the config does not exist, the harness is installed and remains eligible;
the adapter may create the standard user config after confirmation.

Detection is a snapshot captured before the primary flow. The installer MUST
recheck the executable and target path safety during preflight, but it MUST NOT
continuously scan the machine.

When no supported executable resolves, the interface shows the
`NO_SUPPORTED_HARNESS` notice, includes any `configuration only` findings for
diagnosis, performs no mutation, and exits `0` after the user dismisses it.

### Initial adapter matrix

Only the documented user-level location is in scope. A documented environment
override is honored only where listed below; project and profile layers remain
out of scope.

| Harness ID | Executable | Standard user config | Format | MCP map | Enabled state | Reload hint |
| --- | --- | --- | --- | --- | --- | --- |
| `codex` | `codex` | `${CODEX_HOME:-~/.codex}/config.toml` | TOML | `mcp_servers.<server>` | `enabled = true/false` | Start a new Codex session or restart the active client. |
| `hermes` | `hermes` | `${HERMES_HOME:-~/.hermes}/config.yaml` | YAML | `mcp_servers.<server>` | `enabled: true/false` | Run `/reload-mcp` or start a new Hermes session. |
| `openclaw` | `openclaw` | `${OPENCLAW_CONFIG_PATH:-~/.openclaw/openclaw.json}` | JSON5 | `mcp.servers.<server>` | `enabled: true/false` | The gateway normally hot-applies MCP changes; use `openclaw mcp status` to inspect them. |

`CODEX_HOME` and `HERMES_HOME` are directory overrides to which the documented
file name is appended. `OPENCLAW_CONFIG_PATH` is a file override. The resulting
target MUST resolve to an absolute config-file path inside the current user's
home. Empty, relative, home-escaping, NUL-containing, or wrongly typed overrides
make that harness ineligible and produce `HARNESS_CONFIG_UNSAFE`.

These mappings were verified against the harness documentation available on
2026-07-28. Each adapter MUST carry fixtures for its documented shape. A later
harness format change is an adapter compatibility change, not permission to
guess or fall back to another path.

## Local registry contract

### Source and lifecycle

The source registry is `packages/installer/registry/capabilities.json`. It is
included in the published package and loaded relative to the package, not the
current working directory. The file is immutable from the installer's point of
view. Adding or changing a production entry requires repository review, registry
validation, acceptance fixtures for every supported harness, and a package
release.

The installer MUST perform no DNS, HTTP, Git, package-manager, or marketplace
operation while loading the registry. The first production release MUST include
at least one real, runnable AI Engine MCP entry in addition to test fixtures.

### Schema

The following shape is normative. TypeScript notation documents the JSON data;
the registry itself is plain JSON.

```ts
interface LocalCapabilityRegistry {
  readonly schemaVersion: 1;
  readonly entries: readonly CapabilityInstallDescriptor[];
}

interface CapabilityInstallDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly capabilityIds: readonly string[];
  readonly server: {
    readonly name: string;
    readonly transport: StdioTransport | StreamableHttpTransport;
  };
}

interface StdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly forwardEnv?: readonly string[];
}

interface StreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly authentication?:
    | { readonly type: "none" }
    | { readonly type: "bearer-env"; readonly variable: string };
  readonly headersFromEnv?: Readonly<Record<string, string>>;
}
```

Example:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "support-engine",
      "version": "1.0.0",
      "title": "Support Engine",
      "description": "Classify and route support tickets.",
      "capabilityIds": ["support.classify-ticket"],
      "server": {
        "name": "ai-engine-support",
        "transport": {
          "type": "stdio",
          "command": "support-engine-mcp",
          "args": ["--transport", "stdio"],
          "forwardEnv": ["SUPPORT_API_TOKEN"]
        }
      }
    }
  ]
}
```

### Registry invariants

**AE-INSTALL-REG-01 — Closed schema.** Every object MUST reject unknown keys.
`schemaVersion` MUST equal numeric `1`; an unknown version fails the whole
registry before harness detection or mutation.

**AE-INSTALL-REG-02 — Unique identities.** Entry `id` and `server.name` values
MUST each be unique across the registry. `id` MUST match
`^[a-z][a-z0-9-]{0,127}$`. `server.name` MUST match
`^[a-z][a-z0-9_-]{0,63}$` so one stable name maps safely to all first-release
harnesses.

**AE-INSTALL-REG-03 — Capability metadata.** `version`, `title`, and
`description` MUST be non-empty after trimming. `capabilityIds` MUST contain at
least one unique non-empty ID. Capability IDs are display and provenance
metadata; the installer never treats them as proof of the server's live tool
catalog.

**AE-INSTALL-REG-04 — One transport.** An entry MUST declare exactly one of
`stdio` or `streamable-http`. SSE, WebSocket, multiple alternatives, and
harness-specific raw fragments are invalid.

**AE-INSTALL-REG-05 — Stdio.** `command` MUST be non-empty and contain no NUL.
`args` are passed as data, never through a shell. Every `forwardEnv` value MUST
match `^[A-Z_][A-Z0-9_]{0,127}$` and be unique. A per-server working directory
is not part of the portable first-release contract because Hermes does not
document one.

**AE-INSTALL-REG-06 — HTTP.** `url` MUST be an absolute HTTP(S) URL without
userinfo, query, or fragment and with an exact `/mcp` path. HTTPS is required
except when the host is exactly `127.0.0.1` or `[::1]`. Authentication defaults
to `none`. A bearer variable and every
`headersFromEnv` value MUST use the environment-name pattern in
`AE-INSTALL-REG-05`. Header names MUST be valid HTTP field names. The
`Authorization` header MUST NOT appear in `headersFromEnv` when
`bearer-env` is selected.

**AE-INSTALL-REG-07 — No secret values.** The registry may contain environment
variable names but MUST NOT contain credential values, bearer tokens, private
keys, passwords, cookies, or credential-bearing URLs. The installer never asks
for or persists a secret.

**AE-INSTALL-REG-08 — Bounded input.** The encoded registry MUST be at most
1,048,576 bytes and contain at most 1,000 entries. An entry may declare at most
100 capability IDs, 128 arguments, 64 forwarded environment variables, and 64
environment-backed HTTP headers. An individual registry string MUST be at most
4,096 Unicode scalar values; `title` is further limited to 120 and `description`
to 1,000.

**AE-INSTALL-REG-09 — Portable mapping.** Every production entry MUST map
losslessly to all three first-release adapters. Registry validation invokes each
adapter's mapping validation and fails the whole registry when, for example, a
forwarded environment name would be rejected by a harness's published stdio
environment safety policy. The registry cannot declare a harness-specific entry
or silently drop a field.

Registry validation reports all detectable issues in deterministic JSON-pointer
order and never includes the rejected value in a diagnostic.

## Canonical MCP mapping

The registry is harness-neutral. Each adapter MUST map only the following
fields. An entry that any adapter cannot represent without changing its meaning
is `REGISTRY_INVALID` before the interactive inventory opens.

### Stdio mapping

| Canonical field | Codex | Hermes Agent | OpenClaw |
| --- | --- | --- | --- |
| `command` | `command` | `command` | `command` |
| `args` | `args` | `args` | `args` |
| `forwardEnv: [NAME]` | `env_vars = ["NAME"]` | `env.NAME: "${NAME}"` | `env.NAME: "${NAME}"` |
| enabled | `enabled = true/false` | `enabled: true/false` | `enabled: true/false` |

The adapter checks only whether each required environment variable is present
and non-empty in the installer process. It MUST NOT read the value into a
preview, state record, error, snapshot, or log. A missing required variable
blocks installation or enabling but does not block disabling.

The adapter resolves `command` during preflight. A bare name must resolve in
the inherited `PATH`; a command containing a path separator must resolve to an
absolute executable regular file. The installer reports only the declared
command and resolved executable path. It never executes either one. A missing
command blocks installation or enabling but does not block disabling.

### Streamable HTTP mapping

| Canonical field | Codex | Hermes Agent | OpenClaw |
| --- | --- | --- | --- |
| `url` | `url` | `url` | `url` plus `transport: "streamable-http"` |
| `bearer-env` | `bearer_token_env_var` | `headers.Authorization: "Bearer ${NAME}"` | `headers.Authorization: "Bearer ${NAME}"` |
| `headersFromEnv.X = NAME` | `env_http_headers.X = "NAME"` | `headers.X: "${NAME}"` | `headers.X: "${NAME}"` |
| enabled | `enabled = true/false` | `enabled: true/false` | `enabled: true/false` |

The installer validates required environment variable presence but does not
connect to the URL. OAuth-authenticated entries are deferred because OAuth
client behavior, token storage, and login commands differ by harness.

Adapter-produced definitions MUST contain only the canonical transport fields
and the native enablement field. The installer MUST NOT add tool filters,
approval bypasses, trust flags, timeouts, parallel-call hints, TLS bypasses, or
other harness-specific behavior that is absent from the registry contract.

## Installer state and ownership

### State file

The installer records ownership in
`${XDG_STATE_HOME:-~/.local/state}/ai-engine/installer.json`:

```ts
interface InstallerState {
  readonly schemaVersion: 1;
  readonly installations: Readonly<Record<string, ManagedInstallation>>;
}

interface ManagedInstallation {
  readonly capabilityId: string;
  readonly registryVersion: string;
  readonly harnessId: "codex" | "hermes" | "openclaw";
  readonly configPath: string;
  readonly serverName: string;
  readonly definitionSha256: string;
  readonly adopted: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}
```

The map key is the deterministic tuple
`<capabilityId>\u0000<harnessId>\u0000<configPath>`. The encoded state file MUST
be at most 1,048,576 bytes. It contains no environment values, headers, URLs with
credentials, source config bytes, or registry snapshots.

The state schema is closed and may contain at most 3,000 installations. Every
map key MUST equal the tuple derived from its value. IDs, server names, and
absolute config paths MUST satisfy their registry and adapter constraints;
`definitionSha256` MUST be 64 lowercase hexadecimal characters; `installedAt`
and `updatedAt` MUST be UTC RFC 3339 timestamps; and `updatedAt` MUST not precede
`installedAt`. Any violation makes the state `STATE_INVALID`; the installer does
not discard or partially recover records.

`definitionSha256` is lowercase hexadecimal SHA-256 over canonical JSON of the
adapter's normalized MCP definition, excluding only the native enabled or
disabled field. Object keys are sorted lexicographically; array order is
preserved. The normalized definition includes the transport, command or URL,
arguments, environment variable names, and header names.

The state file is private installer data, created with mode `0600` under a
directory created with mode `0700` on POSIX. An existing state file must be a
regular, current-user-owned, non-symlink file and must retain its existing mode.
When `XDG_STATE_HOME` is set, it MUST be an absolute, NUL-free path whose
existing components are owned by the current user.
Malformed or unsafe state blocks all mutations but not read-only harness
detection.

### Ownership rules

**AE-INSTALL-OWN-01 — No silent ownership.** The installer MUST NOT treat an MCP
entry as managed merely because its name or definition matches the registry.
Matching state or explicit adoption is required.

**AE-INSTALL-OWN-02 — No overwrite.** A server-name collision with a different
external definition is `conflict`. The installer MUST NOT replace, merge,
rename, disable, or delete it.

**AE-INSTALL-OWN-03 — Drift fails closed.** When the current managed definition
fingerprint differs from state, the installer MUST NOT mutate that harness
entry. It reports `CONFIG_DRIFT` without printing either definition.

**AE-INSTALL-OWN-04 — Registry updates do not rewrite.** When the current entry
still matches its state fingerprint but not the current registry fingerprint,
it is `outdated`. Enable and disable change only the native boolean and preserve
the installed definition. Automatic upgrade is not part of this release.

**AE-INSTALL-OWN-05 — Idempotency.** Installing an already managed enabled entry,
enabling an enabled entry, or disabling a disabled entry produces success with
no config or state write. Repeating the same action yields the same observable
state.

## Configuration mutation contract

### Preflight

Before showing the final confirmation, each target adapter MUST:

1. resolve and recheck the harness executable;
2. resolve the exact standard config path;
3. reject unsafe path components and symlinks;
4. read at most 4,194,304 encoded bytes when the file exists;
5. parse the documented format without evaluating code or substitutions;
6. reject duplicate mapping/table keys, a nesting depth above 100, and any YAML
   alias, anchor, or merge key;
7. verify that every existing path component from the current user's home
   through the target, and the existing target itself, is owned by the current
   user;
8. verify the MCP parent path is absent or has the documented object/table type;
9. classify ownership, collision, enablement, and drift;
10. validate the registry descriptor can be mapped losslessly;
11. check required command and environment-variable presence for install or
    enable;
12. build an in-memory patch and the expected post-write fingerprint;
13. record SHA-256 content hashes for config and installer state optimistic
    concurrency checking.

A failure for one selected target does not suppress clean preflight results for
other targets. The confirmation screen MUST separate writable targets from
blocked targets. The user may proceed only with the writable subset.

### Safe write

For one target, the installer MUST:

1. acquire the installer state lock and then an adjacent target-config lock,
   both through exclusive creation and always in that order;
2. wait at most 2,000 milliseconds total with bounded backoff, returning
   `STATE_LOCKED` or `CONFIG_LOCKED` for the lock that could not be acquired;
3. re-read state and config and compare both with their preflight content hashes;
4. abort as `STATE_CHANGED` or `CONFIG_CHANGED` when another process modified
   the corresponding file;
5. apply a format-preserving patch to only the selected server entry;
6. serialize and parse the result again before writing;
7. write a private temporary regular file in the same directory;
8. flush and atomically rename it over the target;
9. preserve the original file's mode and ownership, or use mode `0600` for a new
   file;
10. atomically write the corresponding installer state;
11. if state writing fails, restore the original config bytes before reporting
    `STATE_WRITE_FAILED`;
12. report `CONFIG_ROLLBACK_FAILED` when that restoration does not complete;
13. release both locks and remove installer-owned temporary files.

Lock metadata may contain only installer PID, creation time, and target path.
The installer never breaks or deletes a lock it did not create. A stale lock
requires manual inspection in this release. The state-first lock order prevents
two installer processes that target different harnesses from losing ownership
records or deadlocking each other. Native harnesses do not honor installer locks;
the content-hash check detects changes completed before the commit re-read but
does not claim a cross-process transaction with a harness writing at the same
instant.

No persistent backup of a harness config is created because these files may
contain credentials unrelated to the selected MCP entry. The original bytes may
exist in memory only for the duration of one target commit and rollback.

An unexpected process termination between config replacement and state commit
may leave a matching external entry. The next run must classify it as `external`
and offer explicit adoption; the installer does not claim crash-atomicity across
two files.

Adoption uses the same state-first lock order and content-hash rechecks, skips
the config replacement, and writes only the ownership record. `installedAt` is
set on the first install or adoption. `updatedAt` changes after a real install,
adoption, enable, or disable; an idempotent action changes neither timestamp and
writes neither file.

### Preservation

For an existing config, a successful mutation MUST preserve:

- every unrelated semantic value;
- comments and comment placement outside the target entry;
- key order outside the target entry;
- the existing newline convention and trailing-newline presence;
- unknown but parseable harness fields;
- file mode and ownership.

The adapter may normalize only the selected server entry. Re-serializing the
whole file through a lossy object serializer is non-conforming for TOML, YAML,
and JSON5. Parser and patcher library choices are internal, but acceptance
fixtures must prove preservation.

When creating a missing config, the adapter writes the smallest valid document
containing the MCP parent map and selected entry, using UTF-8, LF, a trailing
newline, and the harness's documented shape. It creates only the standard
config directory and file, never other harness bootstrap state.

### Multi-target behavior

Each harness target is an independent transaction. Targets are processed in
lexicographic `harnessId`, then `configPath`, order. The batch is not atomic
across harnesses. A failure does not roll back earlier successful targets and
does not prevent later preflight-clean targets from being attempted, unless the
user cancels or the installer state becomes unsafe.

The final screen MUST list `changed`, `unchanged`, `adopted`, `blocked`, and
`failed` targets separately. Exit code `1` is selected when any requested target
is blocked or failed after confirmation.

## Errors and diagnostics

Errors are installer errors, not `EngineError` values. The stable code and
message are the public contract; tests and integrations MUST NOT parse incidental
details.

| Code | Stable message | Retry |
| --- | --- | --- |
| `REGISTRY_INVALID` | `The local capability registry is invalid.` | No; fix and release the registry. |
| `NO_TTY` | `The installer requires an interactive terminal.` | No; rerun in a TTY. |
| `NO_SUPPORTED_HARNESS` | `No supported AI harness was detected.` | No automatic retry. |
| `HARNESS_CONFIG_INVALID` | `The harness configuration is invalid.` | No; repair the config. |
| `HARNESS_CONFIG_UNSAFE` | `The harness configuration path is unsafe.` | No; repair ownership or path. |
| `COMMAND_NOT_FOUND` | `The MCP server command was not found.` | No; install it and rerun. |
| `REQUIRED_ENV_MISSING` | `A required environment variable is missing.` | No; set it and rerun. |
| `CONFIG_CONFLICT` | `A different MCP server already uses this name.` | No; resolve it manually. |
| `CONFIG_DRIFT` | `The managed MCP server was changed outside the installer.` | No; reconcile it manually. |
| `CONFIG_LOCKED` | `The harness configuration is locked.` | One bounded lock wait only. |
| `CONFIG_CHANGED` | `The harness configuration changed during installation.` | No automatic retry; rerun the flow. |
| `CONFIG_WRITE_FAILED` | `The harness configuration could not be updated.` | No automatic retry. |
| `STATE_INVALID` | `The installer state is invalid.` | No; repair the state. |
| `STATE_LOCKED` | `The installer state is locked.` | One bounded lock wait only. |
| `STATE_CHANGED` | `The installer state changed during installation.` | No automatic retry; rerun the flow. |
| `STATE_WRITE_FAILED` | `The installer state could not be updated.` | No automatic retry; config rollback is attempted. |
| `CONFIG_ROLLBACK_FAILED` | `The harness configuration could not be restored.` | No automatic retry; inspect the target manually. |
| `CANCELLED` | `Installation was cancelled.` | Not applicable. |

A diagnostic MAY include the harness ID, registry entry ID, server name, safe
config path, missing environment variable name, or declared command. It MUST NOT
include environment values, existing MCP definitions, whole config fragments,
HTTP headers, registry raw values, stack traces, or cause chains in the
interactive UI.

Multiple registry and preflight issues are reported in deterministic order.
Write failures are not retried automatically because a retry could overwrite a
concurrent user or harness change.

## Security and trust

The bundled registry is trusted release input, not a sandbox or signature. A
registry entry describes code that a harness may later execute with that
harness's privileges. Repository review MUST inspect the command, arguments,
endpoint, environment names, and the upstream engine release before adding an
entry.

The installer MUST satisfy these boundaries:

- never execute a registry command, harness binary, package manager, or shell;
- never connect to a registry or MCP endpoint;
- never interpolate environment values into generated configuration when the
  harness can reference the variable by name;
- never store or render credential values;
- never follow a config or state-file symlink;
- never modify a config not owned by the current user;
- never weaken TLS verification, tool approvals, trust prompts, or harness
  policy;
- never edit enterprise-managed or system configuration;
- never treat a successful write as proof that an MCP server is trustworthy,
  reachable, compatible, or authorized;
- keep all temporary files private and remove them after success or contained
  failure;
- contain parser exceptions and filesystem causes behind the stable installer
  errors.

An MCP server can expose powerful tools and can process untrusted content. The
confirmation screen MUST state that enabling the entry lets the selected
harness start or connect to that server in future sessions. This warning is
shown once per target install or adoption, not on every enable toggle.

## Ordering, limits, and operational behavior

| Dimension | First-release limit or rule |
| --- | --- |
| Supported harnesses | Exactly 3: Codex, Hermes Agent, OpenClaw |
| Platforms | Linux, macOS, WSL |
| Registry sources | Exactly 1 bundled local JSON document |
| Registry size | 1 MiB encoded |
| Registry entries | 1,000 |
| Config size | 4 MiB encoded per harness |
| State size | 1 MiB encoded |
| Managed installation records | 3,000 |
| Parsed config nesting | At most 100 mapping/array levels |
| YAML aliases, anchors, merge keys | 0 |
| Transports | stdio and Streamable HTTP |
| Concurrent writes | 1 installer state writer and 1 installer writer per config path |
| Lock wait | At most 2 seconds total per target commit |
| Network operations | 0 |
| Registry command executions | 0 |
| Automatic retries | Lock acquisition only; bounded by 2 seconds |

Detection order is adapter ID order. Registry display order is Unicode code-point
order of `title`, then `id`; no locale-sensitive comparison is used. Target
commit order is `harnessId`, then absolute `configPath`. Registry issue order is
JSON pointer. These orders MUST be stable across repeated runs with the same
inputs.

The installer runs one interactive session and one mutation at a time. It does
not expose an in-process concurrency API. Parsing and patch construction must be
linear in the encoded config and selected registry entry size. Registry
validation must be linear in registry size. Implementations MUST avoid recursive
walks over untrusted parsed data that can overflow the JavaScript stack.

## Versioning and compatibility

- Adding `@ai-engine/installer` is additive and post-v0.1, but it requires the
  package-boundary ADR described above.
- Registry `schemaVersion: 1` is exact. Adding an optional field is still a
  schema change because the schema is closed; it requires a new installer
  release and compatibility decision.
- Changing an entry `id` or `server.name` is breaking for installer ownership
  state and must be modeled as a new entry plus a documented migration.
- Changing `version` without changing the descriptor may update display
  metadata but does not rewrite installed harness config.
- Changing a transport descriptor makes an existing managed install `outdated`;
  automatic upgrade remains out of scope.
- Adding a new harness adapter is additive only when existing registry entries
  retain the same mapping for existing harnesses.
- A harness format change that invalidates fixtures requires an adapter update
  and release. The installer must fail closed rather than attempt a legacy or
  guessed write.
- State `schemaVersion: 1` is exact. A later state version requires an explicit,
  tested, failure-atomic migration before mutation.
- Removing a harness adapter is breaking for users with managed state for that
  adapter and requires a migration or a major package release.

## Acceptance criteria

| ID | Observable outcome | Minimum evidence |
| --- | --- | --- |
| `AE-INSTALL-AC-01` | With `codex`, `hermes`, and `openclaw` fixtures on `PATH`, the UI reports all three as installed without executing them. | Fake executables that fail the test if invoked, plus an injected path-resolver test. |
| `AE-INSTALL-AC-02` | A config file without an executable is shown as `configuration only` and cannot be selected. | Table-driven detection test for all adapters. |
| `AE-INSTALL-AC-03` | A missing config for an installed harness is created only after confirmation, with the documented MCP shape and POSIX mode `0600`. | Child-process fixture for each adapter. |
| `AE-INSTALL-AC-04` | Installing one stdio entry maps command, args, forwarded environment names, and `enabled` correctly for Codex, Hermes, and OpenClaw. | Golden semantic assertions over TOML, YAML, and JSON5 fixtures. |
| `AE-INSTALL-AC-05` | Installing one Streamable HTTP entry maps URL, bearer environment authentication, environment-backed headers, and `enabled` correctly for all adapters without a network request. | Adapter tests with a network-call sentinel. |
| `AE-INSTALL-AC-06` | Install, disable, and enable transition `available → enabled → disabled → enabled` without losing the transport definition. | End-to-end interactive test for each adapter. |
| `AE-INSTALL-AC-07` | Repeating install, enable, or disable on the resulting state performs no config or state write. | Writer spies plus mtime/content assertions. |
| `AE-INSTALL-AC-08` | A matching external entry can be adopted only after explicit confirmation and adoption does not rewrite its config. | Interactive adoption test and writer spy. |
| `AE-INSTALL-AC-09` | A same-name, different external entry is `conflict`, is never overwritten, and emits no definition content. | Table-driven conflict and diagnostic-safety tests. |
| `AE-INSTALL-AC-10` | Manual change to a managed definition produces `drifted`; enable and disable make no write. | State fingerprint regression test. |
| `AE-INSTALL-AC-11` | A registry descriptor change produces `outdated`; toggling changes only the native boolean and preserves the installed descriptor. | Old-state/new-registry fixture. |
| `AE-INSTALL-AC-12` | Comments, unrelated values, key order outside the selected entry, newline convention, trailing-newline state, mode, and ownership survive each adapter mutation. | Byte-aware preservation fixtures for TOML, YAML, and JSON5. |
| `AE-INSTALL-AC-13` | Malformed config, duplicate key, depth 101, YAML alias/anchor/merge, wrong MCP parent type, oversized config, symlink, wrong owner, relative or home-escaping override, and unsafe state each fail before a write. | Boundary fixtures with writer spies and POSIX filesystem tests. |
| `AE-INSTALL-AC-14` | A config changed after preflight produces `CONFIG_CHANGED` and retains the concurrent bytes. | Deterministic concurrency test with a pre-commit barrier. |
| `AE-INSTALL-AC-15` | A second writer cannot acquire the state or adjacent config lock within the two-second total budget, cannot lose state while targeting another harness, and does not alter a lock or config it does not own. | Two-process lock integration tests with a fake clock where possible. |
| `AE-INSTALL-AC-16` | State-write failure restores the exact original config and reports `STATE_WRITE_FAILED`; restoration failure reports `CONFIG_ROLLBACK_FAILED` without exposing bytes. | Fault-injected filesystem tests. |
| `AE-INSTALL-AC-17` | Missing command or required environment blocks install/enable, while disable remains available; no environment value reaches UI, state, or captured logs. | Process-environment and diagnostic leak tests using unique secret sentinels. |
| `AE-INSTALL-AC-18` | Registry unknown fields, duplicate IDs/names, invalid or adapter-unmappable transports/URLs/env names, empty metadata, count limits, and inclusive/exclusive byte limits fail deterministically. | Table-driven registry and cross-adapter contract tests at every boundary. |
| `AE-INSTALL-AC-19` | Running without both TTYs exits `2`; cancel before writing exits `0`; `SIGINT` exits `130`; none corrupts a config or state file. | Pseudoterminal child-process tests. |
| `AE-INSTALL-AC-20` | In a three-target operation, results are attempted in adapter order, prior successes remain when one target fails, later clean targets still run, and exit code is `1`. | Fault-injected multi-target integration test. |
| `AE-INSTALL-AC-21` | A registry containing 1,000 valid entries and a depth-100, 4 MiB valid config is validated and inspected without stack overflow or superlinear adapter passes; depth 101 fails before patching. | Instrumented inclusive/exclusive limit test. |
| `AE-INSTALL-AC-22` | Source inspection and runtime sentinels prove the installer imports no framework package, invokes no engine, opens no network connection, and runs no harness, shell, package manager, or registry command. | Import-graph check plus child-process/network sentinels. |
| `AE-INSTALL-AC-23` | `--help` and `--version` succeed without registry, harness, state, or network access; unknown arguments exit `2`. | CLI child-process tests. |
| `AE-INSTALL-AC-24` | The published package contains the validated registry and binary, and a clean install can configure at least one real AI Engine MCP entry. | Packed-package smoke test in an isolated home and `PATH`. |

## Traceability

| Requirement | Contract surface | Acceptance evidence |
| --- | --- | --- |
| Detect installed AI harnesses | Finite adapter list, executable-only detection, config-only state | `AE-INSTALL-AC-01`, `AE-INSTALL-AC-02` |
| Interactive install, enable, and disable | Primary flow, status model, exit and cancellation contract | `AE-INSTALL-AC-03`, `AE-INSTALL-AC-06`, `AE-INSTALL-AC-07`, `AE-INSTALL-AC-19`, `AE-INSTALL-AC-23` |
| Local capability registry | Closed schema, identity, transports, limits, packaged source | `AE-INSTALL-AC-18`, `AE-INSTALL-AC-21`, `AE-INSTALL-AC-24` |
| Correct harness configuration | Adapter matrix and canonical MCP mapping | `AE-INSTALL-AC-04`, `AE-INSTALL-AC-05` |
| Preserve user configuration | Preflight, atomic patch, format preservation | `AE-INSTALL-AC-12` through `AE-INSTALL-AC-16` |
| Ownership and collision safety | State fingerprint, adopt, conflict, drift, outdated | `AE-INSTALL-AC-08` through `AE-INSTALL-AC-11` |
| Secret and execution safety | Environment references, no command/network execution, sanitized errors | `AE-INSTALL-AC-09`, `AE-INSTALL-AC-17`, `AE-INSTALL-AC-22` |
| Determinism and bounded operation | Ordering, byte/count limits, lock timeout, independent targets | `AE-INSTALL-AC-15`, `AE-INSTALL-AC-18`, `AE-INSTALL-AC-20`, `AE-INSTALL-AC-21` |
| Existing architecture remains unchanged | Standalone package, MCP configuration boundary, no framework imports | `AE-INSTALL-AC-22`, package dependency review |

## Delivery slices

Implementation follows ADR 0008. Each slice begins with failing executable
evidence, ends green, and is one cohesive commit:

1. Record the package and architectural boundary in a new ADR, including the
   relationship with ADRs 0001, 0004, 0005, and 0009.
2. Add the `@ai-engine/installer` package skeleton, injectable filesystem and
   terminal boundaries, stable installer errors, and CLI usage behavior.
3. Add the closed registry schema, limits, source packaging, normalization, and
   production registry review workflow.
4. Add executable-only harness detection and the read-only interactive inventory.
5. Implement state ownership, fingerprints, adoption, conflicts, drift, and
   idempotent planning without config writes.
6. Implement the Codex TOML adapter with preservation and atomic-write tests.
7. Implement the Hermes YAML adapter with preservation and atomic-write tests.
8. Implement the OpenClaw JSON5 adapter with preservation and atomic-write tests.
9. Add lock handling, optimistic concurrency, state rollback, cancellation, and
   independent multi-target commits.
10. Add the full interactive flow, pseudoterminal tests, secret sentinels,
    package smoke test, one real registry entry, and user documentation.

No slice may add a harness by copying a raw config fragment into the registry.
Every harness requires an adapter, current source evidence, preservation
fixtures, error boundaries, and the same install/enable/disable acceptance path.

## Deferred and unspecified

The following require later evidence and an explicit specification update:

- Claude Code, Gemini CLI, OpenCode, Cursor, VS Code, and other harness adapters;
- native Windows support;
- project, workspace, profile, system, managed, container, and remote-host
  scopes;
- user-authored registry overlays and multiple local registry sources;
- a remote registry, search, marketplace, signatures, attestations, and trust
  scoring;
- downloading or updating engine packages, binaries, containers, or source;
- uninstall, descriptor upgrade, server-name migration, and state repair tools;
- MCP health probes, tool discovery, OAuth login, and credential stores;
- per-tool filters or capability-level enablement inside a multi-tool server;
- automatic stale-lock recovery and crash-atomic transactions across config and
  state files;
- a unified `ai-engine` launcher shared with `@ai-engine/tooling`;
- a public programmatic API or non-interactive mutation commands;
- telemetry, analytics, remote error reporting, and registry usage metrics.

The concrete terminal UI library, TOML/YAML/JSON5 patch libraries, and internal
adapter type signatures are implementation details. They remain replaceable only
while all observable behavior and acceptance criteria in this specification are
preserved.

## Harness source notes

The initial adapter contracts were derived from these primary sources and must
be rechecked when implementation begins:

- [Codex Model Context Protocol configuration](https://learn.chatgpt.com/docs/extend/mcp.md)
- [Hermes Agent MCP configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)
- [Hermes Agent MCP config reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md)
- [OpenClaw MCP commands and configuration](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw configuration reference](https://docs.openclaw.ai/gateway/configuration-reference)
