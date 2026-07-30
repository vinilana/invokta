# ADR 0012: Standalone Invokta engine creator

- Status: Accepted
- Date: 2026-07-29

## Context

Engine authors currently assemble the package manifest, TypeScript configuration,
capability, composition root, execution entry points, and first test by hand or
adapt the repository-local `hello-engine` example. The example is not a
standalone template: its configuration and package metadata belong to this
workspace. Invokta needs one bounded bootstrap path that produces a runnable
engine without turning project creation into a runtime concern or duplicating
deployment authority.

## Decision

Invokta publishes a seventh native ESM package, `create-invokta-engine`. It is a
binary-only supporting application exposing the executable of the same name.
This decision supersedes only the six-package list and supporting-package count
in ADR 0004; its dependency direction and package isolation remain in force.

The public command surface is:

```text
create-invokta-engine <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-engine --help
create-invokta-engine --version
```

Creation is non-interactive. The target is relative to the working directory;
absolute paths and parent-directory segments are rejected. `.` is accepted when
the working directory itself is otherwise a valid empty target. The argument is
limited to 1,024 Unicode scalars and 32 non-dot path segments. The final segment,
or the working-directory name for `.`, becomes both the private package name and
engine name. It must be lowercase kebab-case and at most 214 characters.

The target may be absent or an empty real directory. A symbolic-link target, a
symbolic-link path component, a non-directory target, or any existing directory
entry fails before a scaffold write. Generated text files are fixed,
deterministic UTF-8 with LF endings and one trailing newline. Files and symbolic
links use exclusive creation and never replace an existing entry. A pre-install
failure rolls back only entries and directories created by that invocation; a
rollback failure is reported and may leave those new paths for manual
inspection. Concurrent creation in one target is unsupported, while exclusive
writes ensure neither invocation overwrites the other.

The fixed starter contains these paths in lexicographic order:

```text
.agents/skills/develop-invokta-project/SKILL.md
.agents/skills/develop-invokta-project/agents/openai.yaml
.gitignore
AGENTS.md
CLAUDE.md -> AGENTS.md
README.md
invokta.mcp.json
package.json
src/capabilities/create-welcome-message.ts
src/cli.ts
src/direct.ts
src/engine.ts
src/mcp-stdio.ts
test/engine.test.ts
tsconfig.json
tsconfig.test.json
```

`AGENTS.md` is a regular UTF-8 text file. `CLAUDE.md` is the relative symbolic
link defined by ADR 0015 rather than a second text file.

The `develop-invokta-project` skill is the Action Engine development workflow
defined by ADR 0016.

It defines one deterministic public capability and reuses it through direct
invocation, `@invokta/cli`, and MCP stdio. It contains no model provider,
identity implementation, HTTP server, deployment template, runtime plugin,
telemetry, or Git initialization. HTTP preparation remains owned by
`@invokta/deploy`. Generated Invokta dependency versions exactly match the
creator version. Template changes affect only projects created by that creator
release; generated files are user-owned and are never upgraded in place.

The generated version-one `invokta.mcp.json` manifest statically identifies the
compiled MCP stdio entry point and declared starter capability. The package adds
`@invokta/installer` as a development dependency plus `mcp:install` and
`mcp:uninstall` scripts. Install builds before starting the interactive
project-local installation defined by ADR 0013. Uninstall invokes the
engine-scoped removal defined by ADR 0017 without building or requiring the
compiled entry point.

Unless `--no-install` is present, the creator runs exactly one package-manager
install as a direct child process without a shell. An explicit package manager
wins; otherwise the creator recognizes npm, pnpm, or Yarn from
`npm_config_user_agent` and falls back to npm. It executes `npm install
--no-audit --no-fund`, `pnpm install`, or `yarn install`, respectively. The
creator adds no retry or timeout to the foreground install. User cancellation
ends the operation through normal foreground process signal handling. A failed
or unavailable package manager produces a failed command but preserves the
completed scaffold so the author can retry. `--no-install` starts no child
process and performs no network operation. The creator itself performs no
network request.

Help, version, and the final success summary use standard output. Creator
diagnostics use standard error; an install child inherits the terminal streams.
The exit status is `0` for success, `1` for a target, filesystem, or installation
failure, and `2` for invalid usage or an invalid project path or name. Public
diagnostics use the stable codes `TARGET_INVALID`, `TARGET_UNSAFE`,
`TARGET_NOT_EMPTY`, `SCAFFOLD_CONFLICT`, `WRITE_FAILED`, and `INSTALL_FAILED`.
They may identify a generated project-relative path or one of the three package
manager names, but never echo a rejected argument, environment value, child
error, stack, or cause.

The package imports no Invokta runtime package and creates no capability
execution path. Its acceptance boundary is the generated consumer: the packed
creator must generate a project that installs from packed release artifacts,
type-checks, tests, builds, and invokes the same capability directly, through the
CLI, and through MCP stdio.

## Consequences

- `npm create invokta-engine@latest my-engine` has one stable Invokta-owned
  initializer behind it.
- Project creation becomes a separately versioned compatibility surface without
  expanding the core or either runtime adapter.
- The fixed starter is intentionally narrower than an application template
  system; additional templates require repeated use-case evidence and another
  contract decision.
- Package-manager installation is the sole external process and potential
  network activity; offline and embedded workflows use `--no-install`.
- Release verification must cover the creator tarball, executable, deterministic
  scaffold, and isolated generated consumer.
