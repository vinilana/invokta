# create-invokta-engine

Create a standalone TypeScript Action Engine with one deterministic capability
and a selected execution profile, import selected capabilities from a local
OpenAPI contract, or import a public GitHub example tree as the project
template. Every generated profile entry point imports the same engine and
reaches capability execution through `engine.invoke` or an official Invokta
adapter.

## Commands

```text
create-invokta-engine [project-directory]
  [--profile complete|mcp-stdio|mcp-http|cli]
  [--example <name|github-url>]
  [--example-path <subdir>]
  [--openapi <local-json-or-yaml-file>]
  [--exclude <operation-id|METHOD:/path>]...
  [--package-manager npm|pnpm|yarn]
  [--no-install]
  [--yes]
create-invokta-engine --help
create-invokta-engine --version
```

The npm initializer shorthand resolves to this package:

```sh
npm create invokta-engine@latest my-engine
```

When standard input and standard error are TTYs, the command asks for a missing
project directory and profile, displays the normalized plan, and requires a
final confirmation before writing. An explicit target or profile skips only its
question. `--example` skips the profile prompt and confirms the example label
instead. `--yes` requires an explicit target and skips every prompt.

Non-terminal execution never prompts or reads standard input. It requires an
explicit target and uses `complete` when `--profile` is omitted, preserving
automation such as:

```sh
create-invokta-engine my-engine --no-install
```

Terminal automation should make its choices explicit:

```sh
create-invokta-engine my-engine --profile complete --no-install --yes
create-invokta-engine my-engine --example auth-clerk-engine --no-install --yes
create-invokta-engine my-engine --openapi ./openapi.yaml --no-install --yes
```

`--example` and `--openapi` are mutually exclusive. `--example-path` requires
`--example`, and `--exclude` requires `--openapi`. OpenAPI import may be
combined with any starter profile.

The invoking package manager is inferred from `npm_config_user_agent`, with npm
as the fallback. Use `--package-manager` to choose explicitly. `--no-install`
skips the package manager. Profile creation without `--example` starts no
creator-owned network operation. Example import still contacts GitHub.

## Profiles

| Profile | Execution channels | Entries |
| --- | --- | ---: |
| `complete` | Direct, CLI, MCP local over stdio, MCP HTTP | 21 |
| `mcp-stdio` | Direct, MCP local over stdio | 15 |
| `mcp-http` | Direct, MCP HTTP | 18 |
| `cli` | Direct, CLI | 14 |

Every profile contains these common entries:

```text
.agents/skills/develop-invokta-project/SKILL.md
.agents/skills/develop-invokta-project/agents/openai.yaml
.gitignore
AGENTS.md
CLAUDE.md -> AGENTS.md
README.md
package.json
src/capabilities/create-welcome-message.ts
src/direct.ts
src/engine.ts
test/engine.test.ts
tsconfig.json
tsconfig.test.json
```

Every profile also installs `@invokta/devtools` as a development dependency
and exposes `devtools` for the build-and-watch interface plus
`devtools:doctor` for read-only project diagnostics.

CLI adds `src/cli.ts` and `@invokta/cli`. MCP local adds
`invokta.mcp.json`, `src/mcp-stdio.ts`, `@invokta/mcp`,
`@invokta/installer`, and its stdio/install/uninstall scripts. MCP HTTP adds
`.env.example`, `invokta.deploy.json`, `src/env.ts`, `src/http-auth.ts`,
`src/mcp-http.ts`, `@invokta/mcp`, `@invokta/deploy`, and its HTTP/package/probe
scripts. Dependencies are set unions and appear once.

Every MCP profile also adds development-time `@invokta/tooling` and a
`check:mcp` script. Its canonical `check` builds the engine and validates the
final published MCP catalog, catching derived tool-name collisions before an
adapter starts, installs, or deploys. CLI-only projects omit the MCP gate.

HTTP scaffold bytes come from the pure public `@invokta/deploy/scaffold`
planner. The creator merges the complete plan before writing and never runs the
deploy CLI. The generated authentication hook fails closed until implemented,
and HTTP profiles ignore `.env` and `.env.*` while retaining `.env.example`.

Generated `README.md`, `AGENTS.md`, and `develop-invokta-project` skill guidance
describe only the selected channels. The project instructions and skill also
distinguish capabilities, engine-owned ports, and typed outbound connectors,
including synchronous configuration validation, explicit dependencies,
cancellation, bounded work, failure sanitization, and port-only injection.
`CLAUDE.md` is a real relative symbolic
link to `AGENTS.md`; unsupported link creation fails and rolls back rather than
copying the instructions. Generated Invokta dependencies exactly match the
creator version. All generated entries become project-owned and are never
updated in place.

## GitHub example import

`--example` imports a public GitHub repository or subdirectory as the project
template, similar to `create-next-app --example`:

```sh
create-invokta-engine my-engine --example auth-clerk-engine --no-install --yes
create-invokta-engine my-engine \
  --example https://github.com/acme/engine-template \
  --no-install --yes
create-invokta-engine my-engine \
  --example https://github.com/acme/repo/tree/main/templates/engine \
  --no-install --yes
```

Official short names resolve to `vinilana/invokta` `examples/<name>` on `main`.
HTTPS `github.com` repository and tree URLs are accepted. `--example-path`
selects the subdirectory and, for tree URLs, recovers slash-containing refs the
same way `create-next-app` does. The creator verifies `package.json` is a
regular file, downloads from `codeload.github.com` after confirmation, copies
only the selected subtree, and rewrites `package.json` `name` to the project
directory name. Private repositories, SSH, tokens, and non-GitHub hosts are
unsupported. Links and unsupported archive types are rejected in the exact
selected subtree but ignored outside it because they are not extracted. Unsafe
paths, including raw backslash paths, reject the whole archive consistently on
POSIX and Windows. Template dependency completeness belongs to the example
author.

## OpenAPI capability import

`--openapi` analyzes a local OpenAPI 3.1.x JSON or YAML document and generates
ordinary TypeScript capabilities for supported HTTP operations. It does not
contact the described API while importing.

Every eligible operation is selected by default. In an interactive terminal,
the command displays a numbered catalog and asks which operation numbers to
exclude. For automation, repeat `--exclude` with a unique `operationId` or a
canonical `METHOD:/path` selector:

```sh
create-invokta-engine my-engine \
  --profile cli \
  --openapi ./openapi.yaml \
  --exclude deleteAccount \
  --exclude 'POST:/internal/reindex' \
  --no-install \
  --yes
```

The importer infers server precedence, server-variable defaults, parameter
locations and serialization, JSON request and success-response contracts, and
anonymous, API-key, Basic, or Bearer upstream authentication. It generates one
typed outbound connector that privately owns HTTP and operation plans, then
injects only a narrow operation port into each capability. Connector
configuration is allowlisted and validated synchronously before engine
construction, and external responses are validated by the connector before
they become capability outputs. Generated credentials are environment-variable
names only; values remain runtime configuration in `upstream.env.example`.
Unsupported operations stay visible with a stable reason and are never
generated with weakened behavior.

The result is a source-generated starting point, not a trusted API mirror.
Review capability names, domain boundaries, `access` rules, upstream base URLs,
and credential handling before deployment.

## Prompt and target safety

Each answer is strict UTF-8 and limited to 4,096 encoded bytes including the
line terminator. The directory and profile questions allow three invalid
answers. Confirmation accepts case-insensitive `y`, `yes`, `n`, or `no`; an
empty confirmation means no. A negative confirmation writes
`Creation cancelled. No files were created.` and performs no filesystem or
package-manager operation. Cancelled example imports also skip the archive
download.

The target must be relative, absent or an empty real directory. Absolute paths,
parent segments, symbolic-link components, non-directories, and non-empty
targets are refused. The creator preflights before confirmation and revalidates
afterward. Files and the instruction symlink use exclusive creation; a write
failure rolls back only entries created by that invocation.
Unicode control, format, line-separator, and paragraph-separator characters in
an accepted parent path are escaped in the confirmation instead of being
emitted as terminal-active text.

Unless `--no-install` is present, exactly one shell-free foreground package
manager install starts after every selected scaffold or example entry exists. An
install failure preserves the complete generated project for retry.

## Exit codes and diagnostics

| Exit | Meaning |
| ---: | --- |
| `0` | Help, version, creation, or normal cancellation succeeded |
| `1` | Prompt interruption, target safety, filesystem, import, or installation failed |
| `2` | Usage, required interaction, prompt input, path, name, or import input was invalid |

Creator diagnostics are `INTERACTIVE_REQUIRED`, `PROMPT_INVALID`,
`PROMPT_ABORTED`, `TARGET_INVALID`, `TARGET_UNSAFE`, `TARGET_NOT_EMPTY`,
`SCAFFOLD_CONFLICT`, `WRITE_FAILED`, `INSTALL_FAILED`, `EXAMPLE_INVALID`,
`EXAMPLE_UNAVAILABLE`, `EXAMPLE_FAILED`, `OPENAPI_INVALID`,
`OPENAPI_UNAVAILABLE`, `OPENAPI_UNSUPPORTED`, `OPENAPI_SELECTION_INVALID`, and
`OPENAPI_LIMIT_EXCEEDED`. They never include a rejected answer or argument,
environment value, document fragment, credential, child error, stack, or cause.
