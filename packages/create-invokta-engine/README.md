# create-invokta-engine

Create a standalone TypeScript Action Engine with Invokta. The fixed starter
defines one public capability and exposes it through direct invocation, the
Invokta CLI adapter, and MCP stdio without duplicating the handler.

## Commands

```text
create-invokta-engine <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-engine --help
create-invokta-engine --version
```

The npm initializer shorthand resolves to this package:

```sh
npm create invokta-engine@latest my-engine
```

Creation is non-interactive. The target must be a relative absent or empty real
directory. Existing files and symbolic-link path components are refused and
never overwritten.

The invoking package manager is inferred from `npm_config_user_agent`, with npm
as the fallback. Use `--package-manager` to choose explicitly or `--no-install`
to generate files without starting a package manager or performing network I/O.

## Generated project

```text
.gitignore
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

Generated Invokta dependencies use the exact creator version. The files become
project-owned immediately and are never updated in place by the creator.

The starter also includes `@invokta/installer` and a build-first installation
command:

```sh
npm run mcp:install
```

That command validates `invokta.mcp.json`, detects eligible MCP clients,
preselects all of them, and requires one confirmation before changing user
configuration. The installer never imports or executes the engine while
discovering its MCP entry point.

HTTP scaffolding remains a separate, explicit step owned by `@invokta/deploy`.
The starter contains no HTTP server, authentication implementation, model
provider, telemetry, template selection, or Git initialization.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Help, version, or project creation succeeded |
| `1` | Target safety, filesystem creation, or dependency installation failed |
| `2` | Arguments, project path, or project name were invalid |

Creator diagnostics use `TARGET_INVALID`, `TARGET_UNSAFE`, `TARGET_NOT_EMPTY`,
`SCAFFOLD_CONFLICT`, `WRITE_FAILED`, or `INSTALL_FAILED`. Rejected arguments,
environment values, child errors, stacks, and causes are not included.
