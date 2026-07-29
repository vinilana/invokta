# Local capability MCP installer

- Status: Approved for implementation; production release gated
- Target: Post-v0.1
- Change type: Additive end-user package and CLI
- Initial package version: 0.1.0
- Date: 2026-07-28

## Summary

Action Engine users need one local interface that can find supported AI harnesses on
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
server may expose one or more Action Engine capability IDs. Because MCP client
configuration is server-scoped, the installer enables and disables the whole
entry; it does not claim to toggle individual MCP tools within a multi-capability
server.

The first supported harness surfaces are Codex, Hermes Agent, OpenClaw, Claude
Code, Antigravity CLI (`agy`), Antigravity IDE, Cursor, Kimi Code CLI, OpenCode
v2, and Grok Build. Antigravity CLI and Antigravity IDE share one configuration
target, so the release has ten detectable surfaces and nine
independently writable targets. The adapter boundary is intentionally finite and
explicit. The installer does not guess configuration shapes for unknown agents
or unsupported product versions.

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
  `@invokta/mcp`;
- it does not add a registry, discovery service, plugin loader, or mutable state
  to `@invokta/core`;
- it does not discover ESM exports or compose capabilities inside an engine;
- it does not change the responsibility of `@invokta/cli`, whose commands
  continue to execute capabilities only through `engine.invoke`.

The local installation registry described here is a catalog of MCP launch or
connection descriptors. It is not the runtime package registry, community
library discovery, or hot capability composition deferred by ADR 0001 and the
capability composition specification.

Accepted ADR 0010 authorizes the post-v0.1 `@invokta/installer` package,
amends the package boundary in ADR 0004, and distinguishes the end-user
installer from the dev-only `@invokta/tooling` package authorized by ADR 0009.
The package and binary are:

| Artifact | Responsibility |
| --- | --- |
| `packages/installer` / `@invokta/installer` | Registry validation, harness detection, safe configuration mutation, state, and interactive UI |
| `invokta-installer` | Interactive executable; owns no capability execution command |

No existing runtime or tooling package may depend on the installer. The
installer MUST depend directly on `@clack/prompts` for its production
interactive experience and may use format-preserving configuration libraries
and Node built-ins. It must not depend on `@invokta/core`, `@invokta/cli`,
`@invokta/mcp`, or `@invokta/tooling`. `@clack/prompts` is contained behind
an installer-owned terminal port; its types do not appear in a public API. The
package is native ESM and declares the repository runtime floor of Node.js
`>=22.20.0`.

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
  A harness surface is what the user sees and what detection identifies.

**Configuration target**
: One standard user-level MCP configuration file and dialect. Multiple harness
  surfaces may share a target. The first release has ten surfaces and nine
  targets because `antigravity-cli` and `antigravity-ide` both use the
  `antigravity` target.

**Surface detector**
: Installer-owned code that resolves the finite executable evidence for one
  user-facing harness surface without executing it.

**Configuration target adapter**
: Installer-owned code that resolves one standard user config, reads and patches
  its format, maps the canonical MCP descriptor, and reports a reload hint. One
  adapter may serve multiple surfaces. These are not framework adapters and
  never invoke an engine.

**Managed installation**
: A harness MCP entry first written or explicitly adopted by the installer and
  recorded in installer state with a normalized definition fingerprint.

**External entry**
: A harness MCP entry whose server name exists but has no installer ownership
  record.

**Drift**
: A managed harness MCP definition whose normalized transport fields no longer
  match the fingerprint recorded when the installer last adopted or wrote it.
  A harness-native enabled or disabled field is excluded from this fingerprint.
  For a detached-toggle target, manually recreating or changing a suspended
  server entry is also drift.

## User-facing CLI

### Commands

The public command surface is deliberately small:

```text
invokta-installer
invokta-installer --help
invokta-installer --version
```

Running without arguments starts the interactive interface. Any other argument
is invalid usage. The first release has no hidden non-interactive mutation mode.
The installer orchestrator returns `Promise<0 | 1 | 2 | 130>` and neither calls
`process.exit` nor mutates `process.exitCode`; the binary composition root owns
the final process status. This internal seam is testability infrastructure, not
a published programmatic mutation API.

The command MUST require an interactive input terminal and output terminal.
When either is unavailable, it MUST fail without reading or writing registry,
state, or harness configuration.

`--help` writes English usage with one trailing LF to stdout and exits `0`.
`--version` writes only the `@invokta/installer` manifest version and one
trailing LF to stdout and exits `0`; its initial value is `0.1.0`. Invalid usage
and pre-interactive initialization errors write one sanitized diagnostic to
stderr and use the exit mapping below. Invalid usage writes exactly
`Invalid arguments. Run "invokta-installer --help".` followed by one LF; it is
a usage diagnostic, not an installer error code. The interactive Clack session
owns stdout only after TTY and initialization gates have passed; stack traces
and cause chains never reach either user-facing stream.

### Interactive experience with `@clack/prompts`

`@clack/prompts` is normative for the production terminal experience, with
version `1.7.0` as the reviewed baseline. The package manifest may use the
repository's normal compatible-version policy, but the lockfile MUST select a
reviewed exact version and an upgrade MUST rerun pseudoterminal and cancellation
tests. The installer MUST use these primitives through an internal
`InteractivePrompter` port:

| Stage | Clack primitive | Required behavior |
| --- | --- | --- |
| Session boundary | `intro`, `outro`, `cancel` | Open and close one visually coherent session without terminating the process inside the UI adapter. |
| Capability choice | `autocomplete` | Search up to 1,000 registry options labeled with title and stable ID, show bounded description/capability hints, and return the stable entry ID. |
| Action choice | `select` | Show only actions valid for the selected status, plus explicit Back and Quit choices. |
| Target choice | `multiselect` | Show the eligible configuration targets, surface labels, status, and config-path hint; require at least one target. |
| Review | `note` | Render the bounded, secret-free preflight summary and trust warning. |
| Confirmation | `confirm` | Ask once for the writable target set with `initialValue: false`; Enter alone MUST cancel. |
| Detection and commit feedback | `spinner` and `log` | Stop a spinner before starting another prompt and report every target independently. |

Every value returned by `autocomplete`, `select`, `multiselect`, or `confirm`
MUST pass through `isCancel` before it is narrowed or used. A Clack cancellation
symbol maps to the installer's cancellation result; the UI adapter MUST NOT call
`process.exit`, mutate `process.exitCode`, install global signal handlers, or
perform a config mutation. `SIGINT` is owned by the executable composition root
and retains the exit behavior defined below.

Correctness MUST NOT depend on ANSI color, Unicode symbols, animation frames,
terminal width, or incidental Clack wording. Stable installer codes, target IDs,
actions, paths, and result categories remain installer-owned values. The
production adapter renders English copy, honors `NO_COLOR`, truncates only
display labels rather than IDs or paths, and sends no Clack rendering to stdout
for `--help`, `--version`, invalid usage, or `NO_TTY`.

Most interaction tests target the injected `InteractivePrompter` event model,
not ANSI snapshots. At least one real pseudoterminal test MUST exercise the
locked Clack version for navigation, search, multiselect, default-negative
confirmation, cancellation at every prompt, narrow terminals, and `NO_COLOR`.
Clack package types and cancellation symbols MUST NOT cross the port boundary.

### Primary flow

The interface MUST perform these steps in order:

1. validate the bundled registry;
2. detect every supported harness surface, coalesce surfaces that share a
   configuration target, and inspect any safe, parseable user config;
3. show registry entries in deterministic `title`, then `id`, order;
4. let the user select one entry;
5. show each detected harness surface and the entry's current status for its
   configuration target;
6. offer only actions valid for the selected status;
7. let the user select one or more eligible configuration targets;
8. preflight every selected target without writing;
9. show the action, server name, target config paths, required executable, and
   required environment variable names;
10. require an explicit confirmation whose default is cancel;
11. apply each selected target mutation and report its independent result;
12. show the adapter-specific reload or restart hint for every successful
    target and return to the inventory until the user chooses Quit.

The preview MUST NOT show environment variable values, existing config content,
HTTP credential values, installer state content, or a serialized whole MCP
entry.

One batch applies exactly one of Install, Enable, Disable, or Adopt. After the
action is chosen, the multiselect contains only targets eligible for that action;
the installer never combines different actions into one confirmation or commit
summary.

### Status model

The UI uses these stable statuses for a registry entry in one harness:

| Status | Meaning | Available action |
| --- | --- | --- |
| `available` | No MCP entry exists for the registry server name. | Install |
| `enabled` | The installer manages a matching entry stored as enabled in this user target. | Disable |
| `disabled` | The installer manages a matching entry stored as disabled or suspended in this user target. | Enable |
| `external` | A structurally matching entry exists without installer ownership. | Adopt |
| `conflict` | An external entry uses the same server name with a different definition. | None |
| `drifted` | A managed entry differs from the last applied definition. | None |
| `outdated` | A managed, non-drifted entry matches its recorded definition, but the bundled registry now describes a different definition. It also carries an `enabled` or `disabled` enablement substate. | Disable only when the substate is `enabled`; enable only when it is `disabled`. |
| `invalid-config` | The target config cannot be safely parsed or patched. | None |
| `unsupported` | The target cannot represent one or more canonical descriptor fields without embedding a secret or changing semantics. | None |

Adoption MUST be available only when the external entry's normalized definition
equals the current registry definition. Adoption writes installer state but does
not rewrite the harness config. A conflicting definition cannot be adopted or
replaced in this release.

Each configuration target declares one toggle strategy:

- `native-enabled` writes an explicit `enabled: true/false` equivalent;
- `native-disabled` writes an explicit `disabled: false/true` equivalent;
- `detached` removes only the installer-managed server entry on disable and
  restores the recorded descriptor on enable because the harness documents no
  persistent server toggle.

An omitted native field means enabled when that is the documented target
default. On the first successful mutation of a native-toggle target, the adapter
writes an explicit boolean so later state is unambiguous. A detached disable is
not uninstall: ownership state and a secret-free canonical descriptor snapshot
remain, the server name is reserved, and re-enable restores the exact recorded
descriptor even when the bundled registry has become newer. It removes neither
the config file nor its MCP parent map. Manually inserting anything at that name
while it is detached produces `drifted` and is never overwritten.

Statuses describe only the standard user target. A higher-precedence project,
workspace, profile, managed, plugin, or inline configuration may shadow the same
server name at runtime. The installer does not inspect those out-of-scope layers
and MUST NOT claim that `enabled` proves effective availability in every session.

### Exit codes and cancellation

| Exit code | Meaning |
| --- | --- |
| `0` | The user chose Quit and no confirmed target failed or was blocked during the session. |
| `1` | At least one confirmed target failed or was blocked during the session, including a partial multi-target result. |
| `2` | Invalid usage, no TTY, invalid registry, or installer initialization failure. |
| `130` | `SIGINT` or a Clack cancellation symbol cancelled the interactive session. |

Explicit Back choices and a negative confirmation return to the previous screen
without writing; Quit closes the session. The session accumulates confirmed
target failures, so Quit returns `1` after any such failure and `0` otherwise.
Clack cancellation at a prompt and `SIGINT` exit `130`. `SIGINT` before a target
commit writes nothing. A signal
that arrives during an atomic file replacement is observed immediately after
that critical section; the installer MUST finish or roll back that one target
before exiting. Successful earlier targets in a multi-target operation remain
applied and appear in the final summary.

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

A harness surface is `installed` when one of its declared executable names
resolves through the inherited `PATH` to an executable regular file. Resolution
MUST use no shell and MUST not execute the harness, including with `--version`.
An existing standard config without an executable is reported as
`configuration only`; this is weak evidence, not a claim that an application is
installed.

An installed surface is eligible even when its config is absent; the adapter
may create the standard user config after confirmation. A `configuration only`
target is eligible only for patching its existing file, is labeled with the
weaker evidence, and requires the same explicit confirmation. It MUST NOT cause
creation of a missing config or application directory. This permits GUI-first
installations whose optional shell launcher was not installed without scanning
application bundles or treating a stale config as definitive installation.

Detection is a snapshot captured before the primary flow. The installer MUST
recheck its evidence and target path safety during preflight, but it MUST NOT
continuously scan the machine. Surfaces that resolve to one configuration target
are coalesced before status or mutation planning. The UI may say, for example,
`Antigravity (AGY CLI + IDE)`, but there is exactly one selectable target, lock,
patch, state record, result, and reload section for that file.

When no supported executable or standard config is found, the interface shows
the `NO_SUPPORTED_HARNESS` notice, performs no mutation, and exits `0` after the
user dismisses it.

### Initial surface matrix

| Surface ID | Display name | Executable evidence | Configuration target |
| --- | --- | --- | --- |
| `codex` | Codex | `codex` | `codex` |
| `hermes` | Hermes Agent | `hermes` | `hermes` |
| `openclaw` | OpenClaw | `openclaw` | `openclaw` |
| `claude-code` | Claude Code | `claude` | `claude-code` |
| `antigravity-cli` | Antigravity CLI (AGY) | `agy` | `antigravity` |
| `antigravity-ide` | Antigravity IDE | `antigravity`, only when distinct from the resolved `agy` binary or a legacy alias | `antigravity` |
| `cursor` | Cursor | `cursor` or `cursor-agent` | `cursor` |
| `kimi-code` | Kimi Code CLI | `kimi` | `kimi-code` |
| `opencode-v2` | OpenCode v2 | `opencode2` | `opencode-v2` |
| `grok-build` | Grok Build | `grok` | `grok-build` |

Resolving more than one executable for the same surface does not create another
target. Detection compares resolved executable identities; an `antigravity`
launcher that resolves to the same file as `agy`, or is identified as its legacy
alias, counts only as `antigravity-cli`. Legacy OpenCode v1 uses a different
executable and MCP dialect and is not silently treated as OpenCode v2.

### Initial configuration-target matrix

Only the documented user-level location is in scope. A documented environment
override is honored only where listed below; project and profile layers remain
out of scope.

| Target ID | Standard user config | Format and MCP map | Toggle strategy | Reload hint |
| --- | --- | --- | --- | --- |
| `codex` | `${CODEX_HOME:-~/.codex}/config.toml` | TOML, `mcp_servers.<server>` | `native-enabled` | Start a new Codex session or restart the active client. |
| `hermes` | `${HERMES_HOME:-~/.hermes}/config.yaml` | YAML, `mcp_servers.<server>` | `native-enabled` | Run `/reload-mcp` or start a new Hermes session. |
| `openclaw` | Resolved OpenClaw user config, using the precedence below | JSON5, `mcp.servers.<server>` | `native-enabled` | Let an active config watcher hot-apply the change; otherwise restart the Gateway, then inspect with `openclaw mcp status`. |
| `claude-code` | `${CLAUDE_CONFIG_DIR}/.claude.json` when set; otherwise `~/.claude.json` | JSON, `mcpServers.<server>` user scope | `detached` | Start a new Claude Code session and inspect with `/mcp`. |
| `antigravity` | `~/.gemini/config/mcp_config.json` | JSON, `mcpServers.<server>` | `native-disabled` | In AGY use `/mcp` to reload; in the IDE refresh MCP servers or restart it. |
| `cursor` | `~/.cursor/mcp.json` | JSON, `mcpServers.<server>` | `detached` | Start a new Cursor Agent session or restart Cursor. |
| `kimi-code` | `${KIMI_CODE_HOME:-~/.kimi-code}/mcp.json` | JSON, `mcpServers.<server>` | `native-enabled` | Start a new Kimi session and inspect with `/mcp`. |
| `opencode-v2` | `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/opencode.json` or an existing sibling `opencode.jsonc` | JSON/JSONC, `mcp.servers.<server>` | `native-disabled` | Start a new OpenCode v2 session. |
| `grok-build` | `${GROK_HOME:-~/.grok}/config.toml` | TOML, `mcp_servers.<server>` | `native-enabled` | In `/mcps`, press `r` to refresh, or start a new session. |

`CODEX_HOME`, `HERMES_HOME`, `KIMI_CODE_HOME`, `CLAUDE_CONFIG_DIR`, and
`GROK_HOME` are directory overrides to which the documented file name is
appended. `OPENCODE_CONFIG_DIR` selects the OpenCode directory directly;
otherwise `XDG_CONFIG_HOME` selects the parent of its `opencode` directory.
`OPENCLAW_CONFIG_PATH` is a file override. Every resulting target MUST resolve
to an absolute config-file path inside the injected operating-system home.
Empty, relative, home-escaping, NUL-containing, or wrongly typed overrides make
that target ineligible and produce `HARNESS_CONFIG_UNSAFE`, even when a harness
itself would treat an empty override as unset or accept a broader path.

OpenClaw path resolution is finite and deterministic. A trimmed, non-empty
`OPENCLAW_PROFILE` other than case-insensitive `default` is out of first-release
scope and makes the target `unsupported`; the installer does not reproduce CLI
profile projection. A present but empty path override has already failed the
general override rule above and never reaches this precedence algorithm.
`OPENCLAW_HOME` selects the effective home, falling back to
the injected operating-system home, and supplies tilde expansion for every
override and candidate. A non-empty `OPENCLAW_CONFIG_PATH` wins. Otherwise the
adapter checks existing candidates in this order: when
`OPENCLAW_STATE_DIR` is non-empty, its `openclaw.json` then `clawdbot.json`;
then the effective home's `.openclaw/openclaw.json`,
`.openclaw/clawdbot.json`, `.clawdbot/openclaw.json`, and
`.clawdbot/clawdbot.json`. When none exists, the canonical state directory is
the explicit state override, otherwise the first existing `.openclaw` or
`.clawdbot` directory with `.openclaw` preferred, otherwise `.openclaw`; the
selected file is its `openclaw.json`. Every override, effective home, candidate,
and selected path must pass the same real-home containment and ownership checks.
An OpenClaw configuration containing `$include` anywhere is
`HARNESS_CONFIG_AMBIGUOUS`; resolving or mutating split configuration is
deferred.

For OpenCode v2, exactly one of `opencode.json` and `opencode.jsonc` may exist.
The adapter uses the existing file, or creates `opencode.json` when neither
exists. Both existing at once are `HARNESS_CONFIG_AMBIGUOUS`; the installer does
not patch an effective configuration assembled from two source documents.
OpenCode currently gives `opencode.jsonc` higher precedence, but source-aware
ownership across both siblings is intentionally outside the first release.

Claude Code accepts an omitted stdio `type` as well as `type: "stdio"`; both
normalize to one stdio definition for adoption, drift, and fingerprints. Its
`type: "http"` and `type: "streamable-http"` values likewise normalize to one
Streamable HTTP definition. The adapter writes the explicit `stdio` and `http`
forms. Claude's persistent opt-out is project-scoped rather than a user-global
field on the selected server entry, so the user-global target remains
`detached`. Every `projects.*.disabledMcpServers`,
`projects.*.enabledMcpServers`, `enabledMcpjsonServers`, and
`disabledMcpjsonServers` field is unrelated configuration and MUST remain
unchanged.

These mappings were verified against the harness documentation available on
2026-07-28. Every adapter MUST carry fixtures for its documented shape. A later
harness format change is an adapter compatibility change, not permission to
guess or fall back to another path.

## Local registry contract

### Source and lifecycle

The source registry is `packages/installer/registry/capabilities.json`. It is
included in the published package and loaded relative to the package, not the
current working directory. The file is immutable from the installer's point of
view. Adding or changing a production entry requires repository review, registry
validation, compatibility evidence for every target the descriptor claims to
support, and a package release.

The installer MUST perform no DNS, HTTP, Git, package-manager, or marketplace
operation while loading the registry. The first production release MUST include
at least one real, runnable Action Engine MCP entry in addition to test fixtures.
No current private example satisfies that gate. Development builds MAY use an
empty production registry plus test-only fixtures only in the workspace and CI;
that artifact MUST NOT be published as the first production release. The release
gate requires a separately owned, versioned engine artifact or endpoint, an
offline packed-installer configuration smoke test, and separate upstream MCP
protocol evidence that lists and calls the declared capability. The installer
itself still never launches or probes that artifact.

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
        "name": "invokta-support",
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
`^[a-z][a-z0-9_-]{0,63}$` so one stable name maps safely to every first-release
target that can represent the descriptor.

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
`AE-INSTALL-REG-05`. Header names MUST be valid HTTP field names and MUST be
unique under ASCII case-insensitive comparison. Validation and fingerprints use
their lowercase names while an adapter may preserve the declared spelling in a
generated config. `authorization` is reserved case-insensitively when
`bearer-env` is selected. The following transport-controlled or unsafe names
are always rejected in `headersFromEnv`: `host`, `content-length`, `connection`,
`keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
`transfer-encoding`, and `upgrade`.

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

**AE-INSTALL-REG-09 — Explicit compatibility.** Registry validation asks every
configuration-target adapter whether it can map each entry losslessly. A
production entry MUST be compatible with at least one target. An incompatible
target is a deterministic `unsupported` status with a stable, non-secret reason;
it does not invalidate an otherwise canonical registry entry. An adapter MUST
NOT silently drop, embed, or reinterpret a field. Compatibility is computed from
the canonical descriptor and adapter contract, never declared as a raw
harness-specific fragment in the registry.

Registry validation reports all detectable issues in deterministic JSON-pointer
order and never includes the rejected value in a diagnostic.

## Canonical MCP mapping

The registry is harness-neutral. Each adapter MUST map only the following
fields. An entry that no first-release adapter can represent is
`REGISTRY_INVALID`; an entry that only some adapters can represent remains valid
and produces `unsupported` for the others.

### Stdio mapping

| Target | Command and arguments | `forwardEnv: [NAME]` | Toggle encoding |
| --- | --- | --- | --- |
| `codex` | `command`, `args` | `env_vars = ["NAME"]` | `enabled = true/false` |
| `hermes` | `command`, `args` | `env.NAME: "${NAME}"` | `enabled: true/false` |
| `openclaw` | `command`, `args` | `env.NAME: "${NAME}"` when the pinned OpenClaw policy permits `NAME`; otherwise unsupported | `enabled: true/false` |
| `claude-code` | `type: "stdio"`, `command`, `args` | `env.NAME: "${NAME}"` | detached entry |
| `antigravity` | `command`, `args` | unsupported when non-empty | `disabled: false/true` |
| `cursor` | `command`, `args` | `env.NAME: "${env:NAME}"` | detached entry |
| `kimi-code` | `command`, `args` | unsupported when non-empty | `enabled: true/false` |
| `opencode-v2` | `type: "local"`, `command: [command, ...args]` | `environment.NAME: "{env:NAME}"` | `disabled: false/true` |
| `grok-build` | `command`, `args` | `env.NAME: "${NAME}"` | `enabled = true/false` |

`unsupported` in this table is deliberate. Antigravity and Kimi accept literal
environment values in their documented stdio shapes, but the installer does not
persist a current secret value merely to make a descriptor portable.

OpenClaw compatibility pins the MCP stdio environment filter from official
commit `f308af8a344a30432e1b13fa348533e54cd190c8`. The installer ships an exact
reviewed snapshot of that commit's MCP deny keys and rejects a forwarded name
when its trimmed uppercase form matches the snapshot or starts with
`BASH_FUNC_`, `DYLD_`, or `LD_`. The compatibility reason is stable and contains
only the environment variable name. Fixtures MUST reject at least
`NODE_OPTIONS`, `ANSIBLE_CONFIG`, `TF_CLI_CONFIG_FILE`, and `LD_PRELOAD`, and
MUST accept `GITHUB_TOKEN`, `SUPPORT_API_TOKEN`, and `AWS_CONFIG_FILE`. A vendor
policy update is an adapter compatibility change and requires a reviewed
snapshot, fixtures, and installer release.

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

| Target | URL encoding | `bearer-env` | `headersFromEnv.X = NAME` | Toggle encoding |
| --- | --- | --- | --- | --- |
| `codex` | `url` | `bearer_token_env_var` | `env_http_headers.X = "NAME"` | `enabled = true/false` |
| `hermes` | `url` | `headers.Authorization: "Bearer ${NAME}"` | `headers.X: "${NAME}"` | `enabled: true/false` |
| `openclaw` | `url`, `transport: "streamable-http"` | `headers.Authorization: "Bearer ${NAME}"` | `headers.X: "${NAME}"` | `enabled: true/false` |
| `claude-code` | `type: "http"`, `url` | `headers.Authorization: "Bearer ${NAME}"` | `headers.X: "${NAME}"` | detached entry |
| `antigravity` | `serverUrl` | unsupported | unsupported when non-empty | `disabled: false/true` |
| `cursor` | `url` | `headers.Authorization: "Bearer ${env:NAME}"` | `headers.X: "${env:NAME}"` | detached entry |
| `kimi-code` | `url` | `bearerTokenEnvVar: "NAME"` | unsupported when non-empty | `enabled: true/false` |
| `opencode-v2` | `type: "remote"`, `url`, `oauth: false` | `headers.Authorization: "Bearer {env:NAME}"` | `headers.X: "{env:NAME}"` | `disabled: false/true` |
| `grok-build` | `url` | `headers.Authorization: "Bearer ${NAME}"` | `headers.X: "${NAME}"` | `enabled = true/false` |

The installer validates required environment variable presence but does not
connect to the URL. OAuth-authenticated entries are deferred because OAuth
client behavior, token storage, and login commands differ by harness.

Adapter-produced definitions MUST contain only the mapped canonical transport
fields, the native enablement field where applicable, and a required
transport-control field that prevents semantics absent from the registry.
OpenCode's `oauth: false` is the only such first-release field: it prevents an
installer-generated remote entry from entering an OAuth flow. The installer
MUST NOT add tool filters, approval bypasses, trust flags, timeouts,
parallel-call hints, TLS bypasses, or other harness-specific behavior that is
absent from the registry contract.

## Installer state and ownership

### State file

The installer records ownership in
`${XDG_STATE_HOME:-~/.local/state}/invokta/installer.json`:

```ts
interface InstallerState {
  readonly schemaVersion: 1;
  readonly installations: Readonly<Record<string, ManagedInstallation>>;
}

interface ManagedInstallation {
  readonly entryId: string;
  readonly registryVersion: string;
  readonly targetId:
    | "codex"
    | "hermes"
    | "openclaw"
    | "claude-code"
    | "antigravity"
    | "cursor"
    | "kimi-code"
    | "opencode-v2"
    | "grok-build";
  readonly configPath: string;
  readonly serverName: string;
  readonly definitionSha256: string;
  readonly targetContractVersion: 1;
  readonly toggleStrategy:
    | "native-enabled"
    | "native-disabled"
    | "detached";
  readonly suspendedDescriptor?: {
    readonly name: string;
    readonly transport: StdioTransport | StreamableHttpTransport;
  };
  readonly adopted: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}
```

The map key is the deterministic tuple
`<entryId>\u0000<targetId>\u0000<configPath>`. `entryId` MUST equal the selected
`CapabilityInstallDescriptor.id`; the display-only `capabilityIds` array never
participates in ownership, keys, fingerprints, or idempotency. The encoded state
file MUST be at most 16,777,216 bytes. It contains no environment values,
literal header values, credential-bearing URLs, or source config bytes. A
`suspendedDescriptor` is the minimal canonical, secret-free snapshot needed to
restore a detached server and is not a snapshot of the harness config.

The state schema is closed and may contain at most 9,000 installations. Every
map key MUST equal the tuple derived from its value. At most one record may
exist for an `(entryId, targetId)` pair. A record for that pair whose
`configPath` no longer equals the currently resolved standard path makes state
`STATE_INVALID`; automatic relocation and repair are deferred. IDs, server
names, and absolute config paths MUST satisfy their registry and adapter constraints;
`definitionSha256` MUST be 64 lowercase hexadecimal characters; `installedAt`
and `updatedAt` MUST be UTC RFC 3339 timestamps; and `updatedAt` MUST not precede
`installedAt`. Any violation makes the state `STATE_INVALID`; the installer does
not discard or partially recover records. `toggleStrategy` MUST equal the target
adapter's declared strategy. `suspendedDescriptor` MUST be absent for a native
strategy and for an enabled detached entry; it is required exactly when a
detached entry is disabled and absent from the config. It MUST satisfy the same
closed schema, string, transport, URL, and secret rules as the registry.
`targetContractVersion` MUST equal numeric `1` and binds restoration to the
mapping rules in this specification.

State validation does not require `entryId` membership in the currently bundled
registry. A syntactically valid record may retain ownership for a historical
entry removed by a later registry, which is why record-count boundary fixtures
can use more IDs than the current 1,000-entry registry limit. Such an orphan is
not shown as an installable bundle and cannot be mutated automatically; removing
or migrating it requires the explicit migration already required for an entry
ID change.

`definitionSha256` is lowercase hexadecimal SHA-256 over the RFC 8785 JSON
Canonicalization Scheme representation of the adapter's normalized MCP
definition, excluding only the native enabled or disabled field. Header names
are lowercase in the normalized value; documented transport aliases and omitted
defaults normalize to their explicit canonical forms; array order is preserved.
Duplicate keys, lone surrogates, non-finite numbers, or any selected entry that
cannot be represented by RFC 8785 make the harness config invalid before a
fingerprint is computed. The normalized definition includes the transport,
command or URL, arguments, environment variable names, header names, required
transport-control fields, and every other field present inside the selected
server entry. Installer-generated entries contain no such extra fields. Adding
an unknown, policy, timeout, tool-filter, or auth field to a managed entry
therefore changes the fingerprint and fails closed as drift instead of being
lost by a detached toggle. Hash input may contain an existing secret value in
memory, but only the digest is retained or reported. Acceptance fixtures include
a fixed Unicode definition and its expected digest.

The state file is private installer data, created with mode `0600` under a
directory created with mode `0700` on POSIX. An existing state file must be a
regular, current-user-owned, non-symlink file and must retain its existing mode.
When `XDG_STATE_HOME` is set, it MUST be an absolute, NUL-free path whose
existing components are owned by the current user.
Malformed or unsafe state blocks all mutations but not read-only harness
detection.

Registry, state, and harness bytes are decoded as fatal UTF-8. Registry and
state documents MUST NOT contain a UTF-8 BOM. An existing harness config may
contain exactly one leading UTF-8 BOM; the adapter preserves it byte-for-byte.
Malformed UTF-8, a misplaced or repeated BOM, or an encoded document above its
limit fails before confirmation and before any patch is constructed.

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
Fingerprint fixtures include one fixed Unicode normalized definition and its
expected RFC 8785 SHA-256 digest.

**AE-INSTALL-OWN-04 — Registry updates do not rewrite.** When the current entry
still matches its state fingerprint but not the current registry fingerprint,
it is `outdated`. Native toggles change only their boolean. Detached disable
removes the current entry and records its canonical descriptor; detached enable
restores that recorded descriptor. Both strategies preserve the installed
definition. Automatic upgrade is not part of this release.

**AE-INSTALL-OWN-05 — Idempotency.** Installing an already managed enabled entry,
enabling an enabled entry, or disabling a disabled entry produces success with
no config or state write. Repeating the same action yields the same observable
state.

## Configuration mutation contract

### Preflight

Before showing the final confirmation, each target adapter MUST:

1. resolve and recheck the surface executable or existing-config evidence;
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
10. validate the registry descriptor can be mapped losslessly or classify the
    target as `unsupported`;
11. check required command and environment-variable presence for install or
    enable;
12. build an in-memory patch and the expected post-write fingerprint;
13. record the config's SHA-256 content hash and path identity for optimistic
    concurrency checking.

The batch preflight reads installer state once and records one rolling
`expectedStateHash` and `expectedStateIdentity`, including the state file and
parent device/inode when present. All target plans refer to that rolling
baseline; they do not each own an immutable copy that becomes stale after the
first successful state write. In target order, preflight serializes every
prospective config post-image and each cumulative state post-image. A config
post-image may be at most 4,194,304 bytes and a state post-image at most
16,777,216 bytes; one byte more blocks that target before confirmation. A
missing config or state file has a distinguished absent hash and identity rather
than the hash of empty bytes.

A failure for one selected target does not suppress clean preflight results for
other targets. The confirmation screen MUST separate writable targets from
blocked targets. The user may proceed only with the writable subset.

### Safe write

For one target, the installer MUST:

1. from the nearest verified existing parent, create only a missing installer
   state directory and the selected harness's standard config directory, one
   component at a time with mode `0700`; an `EEXIST` race is accepted only after
   the resulting component passes the same owner, directory, and no-symlink
   checks; immediately capture every created or `EEXIST`-verified component's
   device/inode into the rolling state identity or target plan before creating a
   lock;
2. acquire the installer state lock and then an adjacent target-config lock,
   both through exclusive no-follow creation and always in that order;
3. wait at most 2,000 milliseconds total with bounded backoff, returning
   `STATE_LOCKED` or `CONFIG_LOCKED` for the lock that could not be acquired;
4. revalidate every existing component from the operating-system home or state
   root through both targets, including owner, symlink status, parent identity,
   device, and inode captured in the target plan or rolling state identity;
5. re-read state and config, then report `HARNESS_CONFIG_UNSAFE` for an unsafe config identity,
   `STATE_INVALID` for an unsafe state identity, `CONFIG_CHANGED` for safe config
   bytes that differ from the target plan, or `STATE_CHANGED` for safe state
   bytes that differ from the rolling `expectedStateHash`;
6. parse the exact bytes read by the preceding step after those checks;
7. apply a format-preserving patch to only the selected server entry;
8. serialize and parse the result again and enforce the encoded-size limit before
   writing;
9. serialize the state post-image and enforce its encoded-size limit before
   writing either file;
10. create a mode-`0600` private temporary regular file in the same verified
   directory using exclusive no-follow semantics, then verify it with `fstat`;
11. flush the file, revalidate the parent and target identities immediately
   before atomically renaming it over the target;
12. preserve the original file's mode and ownership, or use mode `0600` for a
    new file;
13. atomically write the corresponding installer state through the same
    exclusive temporary-file, `fstat`, flush, revalidation, and rename rules;
14. reopen the successfully renamed state file and update both
    `expectedStateHash` and `expectedStateIdentity` from its exact bytes,
    parent, device, and inode;
15. if state writing fails, re-read the config and restore the original bytes
    only when its hash still equals the installer's exact post-image hash;
16. preserve the current bytes and report `CONFIG_ROLLBACK_FAILED` when the
    compare-and-swap restoration predicate is false or restoration does not
    complete;
17. release both locks and remove only installer-owned temporary files.

The state lock path is exactly `<statePath>.lock`; a config lock is exactly
`<configPath>.invokta-installer.lock`. Each is a mode-`0600` regular file
created exclusively with no-follow semantics. Its closed JSON metadata contains
only `pid` as a positive safe integer, `createdAt` as a UTC RFC 3339 timestamp,
`targetPath` as the corresponding safe absolute path, and `ownershipToken` as
32 lowercase hexadecimal characters generated from 128 random bits. The
installer retains its token in memory and deletes a lock only when the opened
regular file still has the captured device/inode and its metadata contains the
matching token. It never breaks, truncates, replaces, or deletes another lock.
A stale lock requires manual inspection in this release.

The state-first lock order prevents two installer processes that target
different config files from losing ownership records or deadlocking each other.
Native harnesses do not honor installer locks. The no-follow opens, identity
checks, and content hashes protect against symlinks and substitutions that exist
at a check or complete before the final check. Node.js does not expose the
descriptor-relative primitives needed to claim protection from a malicious
same-UID process that swaps a path between the final recheck and the following
filesystem syscall; defending against that adversary is outside the first
release. Completed changes are still detected and never intentionally
overwritten.

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
JSON, JSONC, and JSON5. Parser and patcher library choices are internal, but
acceptance fixtures must prove preservation.

When creating a missing config, the adapter writes the smallest valid document
containing the MCP parent map and selected entry, using UTF-8, LF, a trailing
newline, and the harness's documented shape. It creates only the standard
config directory and file, never other harness bootstrap state.

### Multi-target behavior

Each configuration target is an independent transaction. Targets are processed
in lexicographic `targetId`, then `configPath`, order. The batch is not atomic
across targets. After each successful state write, the next target uses the
updated rolling `expectedStateHash`. A target-local preflight, config-lock,
config-write, rollback, `STATE_LOCKED`, or safely rolled-back
`STATE_WRITE_FAILED` does not roll back earlier successful targets and does not
prevent later preflight-clean targets from being attempted when state remains
readable and matches the rolling hash and identity. `CONFIG_ROLLBACK_FAILED` is
also target-local under that predicate: it preserves the current config bytes,
fails that target, and allows later targets to continue. Only an external
`STATE_CHANGED`, invalid or unsafe state re-read, or cancellation invalidates
every remaining plan and stops the batch; those targets are reported as blocked
and are not committed.

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
| `INSTALLER_INITIALIZATION_FAILED` | `The installer could not be initialized.` | No automatic retry. |
| `NO_TTY` | `The installer requires an interactive terminal.` | No; rerun in a TTY. |
| `NO_SUPPORTED_HARNESS` | `No supported AI harness was detected.` | No automatic retry. |
| `HARNESS_CONFIG_INVALID` | `The harness configuration is invalid.` | No; repair the config. |
| `HARNESS_CONFIG_AMBIGUOUS` | `More than one harness configuration could be selected.` | No; remove the ambiguity and rerun. |
| `HARNESS_CONFIG_UNSAFE` | `The harness configuration path is unsafe.` | No; repair ownership or path. |
| `HARNESS_CONFIG_READ_FAILED` | `The harness configuration could not be read.` | No automatic retry. |
| `TARGET_UNSUPPORTED` | `This capability cannot be configured for the selected harness.` | No; choose a compatible target. |
| `COMMAND_NOT_FOUND` | `The MCP server command was not found.` | No; install it and rerun. |
| `REQUIRED_ENV_MISSING` | `A required environment variable is missing.` | No; set it and rerun. |
| `CONFIG_CONFLICT` | `A different MCP server already uses this name.` | No; resolve it manually. |
| `CONFIG_DRIFT` | `The managed MCP server was changed outside the installer.` | No; reconcile it manually. |
| `CONFIG_LOCKED` | `The harness configuration is locked.` | One bounded lock wait only. |
| `CONFIG_CHANGED` | `The harness configuration changed during installation.` | No automatic retry; rerun the flow. |
| `CONFIG_WRITE_FAILED` | `The harness configuration could not be updated.` | No automatic retry. |
| `STATE_INVALID` | `The installer state is invalid.` | No; repair the state. |
| `STATE_READ_FAILED` | `The installer state could not be read.` | No automatic retry. |
| `STATE_LOCKED` | `The installer state is locked.` | One bounded lock wait only. |
| `STATE_CHANGED` | `The installer state changed during installation.` | No automatic retry; rerun the flow. |
| `STATE_WRITE_FAILED` | `The installer state could not be updated.` | No automatic retry; config rollback is attempted. |
| `CONFIG_ROLLBACK_FAILED` | `The harness configuration could not be restored.` | No automatic retry; inspect the target manually. |
| `CANCELLED` | `Installation was cancelled.` | Not applicable. |

A diagnostic MAY include the surface ID, target ID, registry entry ID, server
name, safe config path, missing environment variable name, declared command, or
stable compatibility reason. It MUST NOT
include environment values, existing MCP definitions, whole config fragments,
HTTP headers, registry raw values, stack traces, or cause chains in the
interactive UI.

Multiple registry and preflight issues are reported in deterministic order.
Write failures are not retried automatically because a retry could overwrite a
concurrent user or harness change.

Fatal registry read, decoding, parse, or schema failures are
`REGISTRY_INVALID`. A filesystem failure while reading an otherwise eligible
harness target is `HARNESS_CONFIG_READ_FAILED`; malformed bytes or structure are
`HARNESS_CONFIG_INVALID`. The equivalent state cases are `STATE_READ_FAILED`
and `STATE_INVALID`. An unexpected failure before a more specific boundary is
established becomes `INSTALLER_INITIALIZATION_FAILED`. Incidental filesystem,
parser, and `Error.message` text is retained only as an internal cause and is
never rendered.

The remaining preflight mappings are exact. Duplicate keys, invalid BOM, depth
overflow, forbidden YAML constructs, a non-JCS selected entry, a wrong MCP
parent type, and encoded-size overflow are `HARNESS_CONFIG_INVALID`. OpenClaw
`$include` and simultaneous OpenCode siblings are
`HARNESS_CONFIG_AMBIGUOUS`. A named OpenClaw profile is
`TARGET_UNSUPPORTED`. A symlink, wrong owner, unsafe identity, invalid path, or
unsafe override is `HARNESS_CONFIG_UNSAFE`. A missing server command is
`COMMAND_NOT_FOUND`; a missing required variable is `REQUIRED_ENV_MISSING`.
State uses `STATE_READ_FAILED` or `STATE_INVALID` at the equivalent read and
validation boundaries. During commit, safe content changes are
`CONFIG_CHANGED` or `STATE_CHANGED`, while completed unsafe path substitutions
retain the config/state unsafe codes.

Directory bootstrap has the same exact split. A safe operating-system failure
while creating the standard config directory is `CONFIG_WRITE_FAILED`; the
equivalent installer-state directory failure is `STATE_WRITE_FAILED`. A created
component or `EEXIST` race that resolves to an unsafe config path is
`HARNESS_CONFIG_UNSAFE`; the equivalent state-path race is `STATE_INVALID`.

## Security and trust

The bundled registry is trusted release input, not a sandbox or signature. A
registry entry describes code that a harness may later execute with that
harness's privileges. Repository review MUST inspect the command, arguments,
endpoint, environment names, and the upstream engine release before adding an
entry.

The installer MUST satisfy these boundaries:

- never execute a registry command, harness binary, package manager, or shell;
- never connect to a registry or MCP endpoint;
- read a required environment variable only as present/non-empty and never
  interpolate its value into generated configuration;
- never store or render credential values;
- never intentionally follow a config, state, lock, or temporary-file symlink;
  reject one whenever it is observed at a required check;
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
| Detectable harness surfaces | Exactly 10: Codex, Hermes Agent, OpenClaw, Claude Code, Antigravity CLI, Antigravity IDE, Cursor, Kimi Code CLI, OpenCode v2, Grok Build |
| Writable configuration targets | Exactly 9; both Antigravity surfaces share `antigravity` |
| Platforms | Linux, macOS, WSL |
| Registry sources | Exactly 1 bundled local JSON document |
| Registry size | 1 MiB encoded |
| Registry entries | 1,000 |
| Config size | 4 MiB encoded per target |
| State size | 16 MiB encoded |
| Managed installation records | 9,000 |
| Parsed config nesting | At most 100 mapping/array levels |
| YAML aliases, anchors, merge keys | 0 |
| Transports | stdio and Streamable HTTP |
| Concurrent writes | 1 installer state writer and 1 installer writer per config path |
| Lock wait | At most 2 seconds total per target commit |
| Network operations | 0 |
| Registry command executions | 0 |
| Automatic retries | Lock acquisition only; bounded by 2 seconds |

Detection order is surface ID order. Registry display order is Unicode
code-point order of `title`, then `id`; no locale-sensitive comparison is used.
Target display and commit order is `targetId`, then absolute `configPath`.
Registry issue order is JSON pointer. These orders MUST be stable across
repeated runs with the same inputs.

The installer runs one interactive session and one mutation at a time. It does
not expose an in-process concurrency API. Parsing and patch construction must be
linear in the encoded config and selected registry entry size. Registry
validation must be linear in registry size. Implementations MUST avoid recursive
walks over untrusted parsed data that can overflow the JavaScript stack.

These per-preflight-pass complexity claims are measured by counters, not elapsed
time. A valid
1,000-entry registry receives one closed-schema validation pass per entry and
exactly 9,000 compatibility calls, once per `(entry, target)` pair; no adapter
rescans the registry. A 4,194,304-byte source config is decoded once and parsed
once, receives exactly one combined inspection/validation traversal and at most
one patch-construction traversal, and then has its candidate post-image decoded
and parsed exactly once for verification. Explicit work stacks perform those
traversals. The root mapping or array has depth `1`; entering a nested mapping
or array adds `1`; scalar members do not add depth. Depth `100` is accepted and
depth `101` fails before patch construction.

## Versioning and compatibility

- Adding `@invokta/installer` is additive and post-v0.1 and is authorized by
  ADR 0010.
- Registry `schemaVersion: 1` is exact. Adding an optional field is still a
  schema change because the schema is closed; it requires a new installer
  release and compatibility decision.
- Changing an entry `id` or `server.name` is breaking for installer ownership
  state and must be modeled as a new entry plus a documented migration.
- Changing `version` without changing the descriptor may update display
  metadata but does not rewrite installed harness config.
- Changing a transport descriptor makes an existing managed install `outdated`;
  automatic upgrade remains out of scope.
- Adding a new surface is additive only when target coalescing remains
  deterministic. Adding a new configuration target is additive only when
  existing registry entries retain their mappings and compatibility statuses for
  existing targets.
- A harness format change that invalidates fixtures requires an adapter update
  and release. The installer must fail closed rather than attempt a legacy or
  guessed write.
- A target mapping change MUST either retain read/restore support for
  `targetContractVersion: 1` or ship a failure-atomic state migration before any
  mutation. It MUST NOT reinterpret a suspended descriptor under a new mapping.
- State `schemaVersion: 1` is exact. A later state version requires an explicit,
  tested, failure-atomic migration before mutation.
- Removing a configuration target is breaking for users with managed state for
  that target and requires a migration or a major package release. Removing only
  one of multiple surfaces for a shared target is a detection compatibility
  change but does not orphan target state.

## Acceptance criteria

| ID | Observable outcome | Minimum evidence |
| --- | --- | --- |
| `AE-INSTALL-AC-01` | Fake executables for all ten surfaces are reported as installed without being executed; AGY CLI and Antigravity IDE resolve to one target. | Failing-if-invoked executable fixtures, injected path resolver, and coalescing assertions. |
| `AE-INSTALL-AC-02` | An existing config without an executable is labeled `configuration only`, may be patched after confirmation, and never authorizes creation of a missing config. | Table-driven detection and writer-spy test for all targets. |
| `AE-INSTALL-AC-03` | A missing config for an installed surface is created only after confirmation, with the documented MCP shape and POSIX mode `0600`. | Child-process fixture for every shipping target. |
| `AE-INSTALL-AC-04` | A stdio entry without forwarded variables maps to every shipping target; a non-empty `forwardEnv` maps exactly where documented and produces `unsupported` elsewhere. | Golden semantic assertions over TOML, YAML, JSON, JSONC, and JSON5 fixtures. |
| `AE-INSTALL-AC-05` | A credential-free Streamable HTTP entry maps to every shipping target; bearer/header environment references map exactly where documented and produce `unsupported` elsewhere, with no network request; every OpenCode remote mapping contains `oauth: false`. | Cross-target adapter tests with semantic golden assertions and a network-call sentinel. |
| `AE-INSTALL-AC-06` | Install, disable, and enable transition `available → enabled → disabled → enabled` without losing the transport definition for `native-enabled`, `native-disabled`, and `detached`. | End-to-end interactive test for every shipping target. |
| `AE-INSTALL-AC-07` | Repeating install, enable, or disable on the resulting state performs no config or state write. | Writer spies plus mtime/content assertions. |
| `AE-INSTALL-AC-08` | A matching external entry can be adopted only after explicit confirmation and adoption does not rewrite its config. | Interactive adoption test and writer spy. |
| `AE-INSTALL-AC-09` | A same-name, different external entry is `conflict`, is never overwritten, and emits no definition content. | Table-driven conflict and diagnostic-safety tests. |
| `AE-INSTALL-AC-10` | Manual change to a managed definition produces `drifted`; enable and disable make no write. | State fingerprint regression test. |
| `AE-INSTALL-AC-11` | A registry descriptor change produces `outdated` with the current enablement substate and only its inverse action; native and detached toggles preserve the installed descriptor rather than installing the new one. | Old-state/new-registry fixtures for all three toggle strategies and both enablement substates. |
| `AE-INSTALL-AC-12` | Comments, unrelated values, key order outside the selected entry, newline convention, trailing-newline state, mode, and ownership survive each adapter mutation. | Byte-aware preservation fixtures for TOML, YAML, JSON, JSONC, and JSON5. |
| `AE-INSTALL-AC-13` | Malformed or non-UTF-8 config, invalid BOM, duplicate key, non-JCS selected entry, depth 101, YAML alias/anchor/merge, OpenClaw `$include`, active OpenClaw profile, wrong MCP parent type, both OpenCode config siblings, oversized config, read failure, symlink, wrong owner, relative or home-escaping override, and unsafe state each fail with the documented stable code before a write. | Boundary fixtures with writer spies and POSIX filesystem tests. |
| `AE-INSTALL-AC-14` | Safe config bytes changed after preflight produce `CONFIG_CHANGED`; a changed parent, symlink, owner, device, or inode produces `HARNESS_CONFIG_UNSAFE`. Both retain the concurrent bytes; a same-UID swap inside the explicitly excluded final syscall race is not claimed. | Deterministic concurrency tests with pre-commit barriers around revalidation and rename. |
| `AE-INSTALL-AC-15` | A second writer cannot acquire the exact mode-`0600` state or config lock within the two-second total budget, cannot lose state while targeting another config, and cannot alter or delete a lock whose device/inode or 128-bit ownership token it does not own. | Two-process lock integration tests with a fake clock where possible. |
| `AE-INSTALL-AC-16` | State-write failure restores the exact original config and reports `STATE_WRITE_FAILED` only when the config still equals the installer post-image; a concurrent post-write change is preserved and reports `CONFIG_ROLLBACK_FAILED` without exposing bytes. | Fault-injected compare-and-swap rollback tests. |
| `AE-INSTALL-AC-17` | Missing command or required environment blocks install/enable, while disable remains available; no environment value reaches UI, state, or captured logs. | Process-environment and diagnostic leak tests using unique secret sentinels. |
| `AE-INSTALL-AC-18` | Registry unknown fields, duplicate IDs/names, invalid transports/URLs/env names, case-insensitive duplicate or reserved headers, entries supported by no target, empty metadata, count limits, and inclusive/exclusive byte limits fail deterministically; partial target incompatibility remains valid. | Table-driven registry and cross-target compatibility tests at every boundary. |
| `AE-INSTALL-AC-19` | Running without both TTYs exits `2`; negative confirmation writes nothing and Quit exits `0` unless an earlier confirmed target failed; Clack cancellation or `SIGINT` exits `130`; none corrupts config or state. | Pseudoterminal child-process tests. |
| `AE-INSTALL-AC-20` | In target order, a four-target batch reports target 1 `changed`, target 2 `failed` with `CONFIG_WRITE_FAILED`, and targets 3 and 4 `changed`, commits all three successes against the rolling state hash/identity, and exits `1`; a safely rolled-back `STATE_WRITE_FAILED` or target-local `CONFIG_ROLLBACK_FAILED` also permits a later clean target, while a separate external state change after target 1 fails target 2 as `STATE_CHANGED` and blocks targets 3 and 4. | Fault-injected multi-target, state-write and rollback-failure, and external-state-change integration tests. |
| `AE-INSTALL-AC-21` | A 1,000-entry registry receives one validation pass per entry and exactly 9,000 entry-target compatibility calls. In one preflight pass, a depth-100, 4,194,304-byte source config is decoded and parsed once, receives one inspection/validation and at most one patch-construction traversal, and its post-image is decoded and parsed once; depth 101 or either post-image limit plus one byte fails before confirmation. | Counter- and spy-based inclusive/exclusive limit tests with no elapsed-time assertion. |
| `AE-INSTALL-AC-22` | Source inspection and runtime sentinels prove the installer imports no framework package, invokes no engine, opens no network connection, and runs no harness, shell, package manager, or registry command. | Import-graph check plus child-process/network sentinels. |
| `AE-INSTALL-AC-23` | `--help` and `--version` succeed without loading Clack, registry, harness, state, or network access; version equals the manifest; unknown arguments exit `2`. | CLI child-process tests and module-load sentinels. |
| `AE-INSTALL-AC-24` | The production package contains the validated registry and binary, and a clean install can configure at least one separately versioned, real Action Engine MCP entry without launching it; upstream release evidence separately lists and calls the declared capability. | Packed-package smoke test in an isolated home and `PATH`, plus referenced upstream artifact and protocol-smoke evidence. |
| `AE-INSTALL-AC-25` | The locked `@clack/prompts` adapter supports autocomplete, multiselect, default-negative confirmation, Back/Quit, cancellation at every prompt, `NO_COLOR`, and a narrow terminal without exposing Clack types or symbols. | Port contract tests plus a real pseudoterminal smoke matrix against the locked package. |
| `AE-INSTALL-AC-26` | When both `agy` and `antigravity` resolve, one user choice produces one preview path, lock, write, state record, result, and reload section. | Shared-target integration test with config/state writer spies. |
| `AE-INSTALL-AC-27` | State accepts exactly 9,000 unique `(entryId, targetId)` records and 16 MiB inclusive, rejects the next record or byte, a duplicate pair, path relocation, or malformed digest, and enforces `targetContractVersion` plus every conditional `suspendedDescriptor` invariant without retaining a secret sentinel. | Inclusive/exclusive state-schema, uniqueness, relocation, and leak tests. |

## Traceability

| Requirement | Contract surface | Acceptance evidence |
| --- | --- | --- |
| Detect installed AI harnesses | Finite surface list, executable/config evidence, shared-target coalescing | `AE-INSTALL-AC-01`, `AE-INSTALL-AC-02`, `AE-INSTALL-AC-26` |
| Interactive install, enable, and disable | Clack port, primary flow, status, toggle strategies, exit and cancellation | `AE-INSTALL-AC-03`, `AE-INSTALL-AC-06`, `AE-INSTALL-AC-07`, `AE-INSTALL-AC-19`, `AE-INSTALL-AC-23`, `AE-INSTALL-AC-25` |
| Local capability registry | Closed schema, identity, transports, limits, packaged source | `AE-INSTALL-AC-18`, `AE-INSTALL-AC-21`, `AE-INSTALL-AC-24` |
| Correct harness configuration | Surface/target matrices, compatibility, canonical MCP mapping | `AE-INSTALL-AC-04`, `AE-INSTALL-AC-05`, `AE-INSTALL-AC-18` |
| Preserve user configuration | Preflight, atomic patch, format preservation | `AE-INSTALL-AC-12` through `AE-INSTALL-AC-16` |
| Ownership and collision safety | State fingerprint, suspended descriptor, adopt, conflict, drift, outdated | `AE-INSTALL-AC-08` through `AE-INSTALL-AC-11`, `AE-INSTALL-AC-27` |
| Secret and execution safety | Environment references, no command/network execution, sanitized errors | `AE-INSTALL-AC-09`, `AE-INSTALL-AC-17`, `AE-INSTALL-AC-22` |
| Determinism and bounded operation | Ordering, byte/count limits, lock timeout, independent targets | `AE-INSTALL-AC-15`, `AE-INSTALL-AC-18`, `AE-INSTALL-AC-20`, `AE-INSTALL-AC-21` |
| Existing architecture remains unchanged | Standalone package, MCP configuration boundary, no framework imports | `AE-INSTALL-AC-22`, package dependency review |

## Delivery slices

Implementation follows ADR 0008. Each slice begins with failing executable
evidence, ends green, and is one cohesive commit:

1. Record the package and architectural boundary in a new ADR, including the
   relationship with ADRs 0001, 0004, 0005, and 0009.
2. Add the `@invokta/installer` package skeleton, injectable filesystem and
   `InteractivePrompter` boundaries, the direct `@clack/prompts` dependency,
   stable installer errors, and CLI usage behavior.
3. Add the closed registry schema, limits, source packaging, normalization, and
   production registry review workflow.
4. Add executable/config-evidence detection, surface-to-target coalescing, and
   the read-only interactive inventory.
5. Implement state ownership, fingerprints, adoption, conflicts, drift, and
   idempotent planning without config writes.
6. Implement the Codex TOML, Hermes YAML, and OpenClaw JSON5 targets with native
   toggle and preservation tests.
7. Implement the Claude Code, Cursor, and Kimi JSON targets, including detached
   toggles and compatibility tests.
8. Implement the shared Antigravity JSON target and prove AGY/IDE coalescing.
9. Implement the OpenCode v2 JSONC and Grok Build TOML targets.
10. Add lock handling, optimistic concurrency, state rollback, cancellation,
    and independent multi-target commits.
11. Add the full Clack flow, pseudoterminal tests, secret sentinels, an isolated
    packed pre-release smoke test using a test-only registry fixture, and user
    documentation.
12. After a separately versioned real engine artifact and upstream MCP protocol
    evidence exist, add the reviewed production registry entry and complete the
    production packed smoke test required by `AE-INSTALL-AC-24`.

No slice may add a target by copying a raw config fragment into the registry.
Every surface requires detection evidence; every target requires an adapter,
current source evidence, preservation fixtures, error boundaries, and the same
install/enable/disable acceptance path.

Slices 6 through 9 deliver in-memory parsing, normalization, compatibility, and
format-preserving patch construction with byte fixtures; no production
confirmed-write path is enabled before slice 10 supplies the safe transaction
coordinator. After slice 9, the full registry compatibility suite reruns the
exact 9,000-call boundary against all nine real target adapters. Slice 11
produces only a validated workspace/CI pre-release. Slice 12 and production
publication remain gated on the separately versioned real engine artifact and
upstream protocol evidence.

## Deferred and unspecified

The following require later evidence and an explicit specification update:

- Gemini CLI, VS Code, legacy OpenCode v1, TRAE AI and its product editions, and
  other harness adapters or product editions;
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
- OpenClaw profiles, split `$include` configuration, and source-aware mutation
  across more than one config document;
- descriptor-relative native filesystem primitives and protection from a
  malicious same-UID process swapping a path between the final recheck and the
  immediately following syscall;
- a unified `invokta` launcher shared with `@invokta/tooling`;
- a public programmatic API or non-interactive mutation commands;
- telemetry, analytics, remote error reporting, and registry usage metrics.

TOML/YAML/JSON/JSONC/JSON5 patch libraries and internal adapter type signatures
are implementation details. `@clack/prompts` is not: replacing it requires a
specification and dependency decision update in addition to preserving all
observable behavior and acceptance criteria.

## Harness source notes

The initial adapter contracts were derived from these primary sources and must
be rechecked when implementation begins:

- [Codex Model Context Protocol configuration](https://learn.chatgpt.com/docs/extend/mcp.md)
- [Hermes Agent MCP configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)
- [Hermes Agent MCP config reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md)
- [OpenClaw MCP commands and configuration](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw configuration reference](https://docs.openclaw.ai/gateway/configuration-reference)
- [OpenClaw environment and path overrides](https://docs.openclaw.ai/help/environment)
- [OpenClaw pinned config-path resolver](https://github.com/openclaw/openclaw/blob/f308af8a344a30432e1b13fa348533e54cd190c8/src/config/paths.ts)
- [OpenClaw pinned MCP environment filter](https://github.com/openclaw/openclaw/blob/f308af8a344a30432e1b13fa348533e54cd190c8/src/agents/mcp-config-shared.ts)
- [OpenClaw pinned environment-policy snapshot](https://github.com/openclaw/openclaw/blob/f308af8a344a30432e1b13fa348533e54cd190c8/src/infra/host-env-security-policy.json)
- [`@clack/prompts` package and interaction primitives](https://www.npmjs.com/package/@clack/prompts)
- [Claude Code MCP scopes and configuration](https://code.claude.com/docs/en/mcp)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code configuration locations](https://code.claude.com/docs/en/configuration)
- [Antigravity MCP configuration shared by IDE and CLI](https://antigravity.google/docs/mcp)
- [Antigravity CLI installation and the `agy` executable](https://antigravity.google/docs/cli/install)
- [Cursor MCP global configuration](https://docs.cursor.com/context/model-context-protocol)
- [Kimi Code CLI MCP configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)
- [OpenCode v2 MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [OpenCode v2 global configuration](https://opencode.ai/v2/docs/config)
- [OpenCode v2 pinned config loader](https://github.com/anomalyco/opencode/blob/982a9044c515482e7792039be1db9c71cb572745/packages/core/src/config.ts)
- [OpenCode v2 pinned config-directory resolver](https://github.com/anomalyco/opencode/blob/982a9044c515482e7792039be1db9c71cb572745/packages/core/src/global.ts)
- [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers)
- [Grok Build user configuration](https://docs.x.ai/build/settings)
- [Grok Build configuration reference](https://docs.x.ai/build/settings/reference)
