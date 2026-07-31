# ADR 0018: Interactive engine creator profiles

- Status: Accepted
- Date: 2026-07-30

## Context

ADR 0012 defines `create-invokta-engine` as a non-interactive command that emits
one fixed direct, CLI, and MCP stdio starter. Authors who need only one adapter
must delete generated code, while authors who need MCP HTTP must run the
separate deploy initializer. Terminal guidance and bounded profile selection
can improve that bootstrap without creating another capability execution path
or transferring HTTP template ownership away from `@invokta/deploy`.

## Decision

This decision supersedes ADR 0012 only where it requires non-interactive
creation and one fixed starter. Its target, filesystem, package-manager,
rollback, installation, diagnostic, and binary-only package boundaries remain
in force. It extends ADR 0011 by exposing the deploy-owned HTTP scaffold planner
through the pure public `@invokta/deploy/scaffold` subpath.

The command surface is:

```text
create-invokta-engine [project-directory]
  [--profile complete|mcp-stdio|mcp-http|cli]
  [--package-manager npm|pnpm|yarn]
  [--no-install]
  [--yes]
create-invokta-engine --help
create-invokta-engine --version
```

The creator determines interaction mode once after parsing. Without `--yes`,
it is interactive only when standard input and standard error are both TTYs.
Interactive use asks for a missing relative project directory, asks for a
missing profile, builds and preflights the complete plan, and requires one final
confirmation before mutation. `--yes` requires an explicit target and skips all
prompts.

Non-terminal execution never reads standard input. An explicit target proceeds
with the explicit profile or the `complete` default. A missing target fails as
`INTERACTIVE_REQUIRED` before template loading, filesystem mutation, or process
execution. This keeps the previous non-terminal positional syntax compatible.

Prompt answers are strict UTF-8 lines of at most 4,096 encoded bytes including
the terminator. Directory and profile questions permit three invalid answers.
The profile accepts only numeric choices `1` through `4`; confirmation accepts
case-insensitive `y`, `yes`, `n`, or `no`, with an empty answer meaning no. A
limit or UTF-8 violation, or three invalid answers, is `PROMPT_INVALID`. EOF,
interruption, or prompt I/O failure is `PROMPT_ABORTED`. A negative confirmation
is a successful, side-effect-free cancellation.

The closed profiles are:

| Profile | Generated execution channels | Entries |
| --- | --- | ---: |
| `complete` | Direct, CLI, MCP stdio, MCP HTTP | 21 |
| `mcp-stdio` | Direct, MCP stdio | 15 |
| `mcp-http` | Direct, MCP HTTP | 18 |
| `cli` | Direct, CLI | 14 |

All profiles share the capability, engine, direct entry point, engine test,
configuration, instructions, and generated development skill. Adapter files,
dependencies, scripts, manifests, and documentation are present only when the
selected profile includes that adapter. All generated Invokta package versions
exactly match the creator version.

Every generated adapter imports the same engine. Direct invocation calls
`engine.invoke`; CLI, MCP stdio, and MCP HTTP use their official adapters, which
also converge on `engine.invoke`. Focused profiles are bounded bootstrap
projects, not claims that omitted adapters are supported. The `complete` profile
remains the release conformance fixture that proves all official adapters
together, so the reuse and single-pipeline invariants are not weakened.

`@invokta/deploy/scaffold` exports `createMcpHttpScaffoldFiles` and
`starterDeployManifest`. The planner returns immutable, lexicographically
ordered project-relative UTF-8 text entries and performs no filesystem,
process, network, engine, or capability operation. The creator depends on the
matching exact deploy version and merges the entire HTTP plan before writing.
It never runs `invokta-deploy init`, imports deploy internals, or copies the
templates. `invokta-deploy init` remains the command for adding HTTP to an
existing project.

The final confirmation displays only the normalized relative target, profile
label, selected package manager, and installation choice. Planning performs no
mutation. Unicode control, format, line-separator, and paragraph-separator
characters are escaped in the target display instead of being emitted as
terminal-active text. After confirmation, the creator revalidates the target
through the existing no-follow and exclusive-create boundary before committing
the scaffold. At most one shell-free package-manager install starts, and only
after all selected entries exist.

The new sanitized diagnostics are:

| Code | Exit | Message |
| --- | ---: | --- |
| `INTERACTIVE_REQUIRED` | `2` | `Interactive input is required when no project directory is provided.` |
| `PROMPT_INVALID` | `2` | `Interactive input is invalid.` |
| `PROMPT_ABORTED` | `1` | `Interactive project creation was interrupted.` |

## Consequences

- Human terminal use gains bounded guidance and an explicit mutation gate.
- CI and non-terminal automation retain positional creation; pseudo-TTY
  automation must add `--yes`.
- The `complete` default now adds MCP HTTP and the matching deploy development
  dependency to the former fixed starter.
- Focused generated projects install, type-check, test, build, and invoke only
  their selected channels without advertising omitted adapters.
- Existing generated projects are unchanged and are never converted in place.
- This is an intentional breaking creator release under the pre-1.0 versioning
  policy; release notes must publish the command migration.
