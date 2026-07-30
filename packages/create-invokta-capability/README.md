# create-invokta-capability

Create a standalone TypeScript package that publishes one atomic Invokta
capability through `defineExportedCapability`.

## Commands

```text
create-invokta-capability <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-capability --help
create-invokta-capability --version
```

The npm initializer shorthand resolves to this package:

```sh
npm create invokta-capability@latest my-capability
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
package.json
src/capability.ts
src/index.ts
test/capability.test.ts
tsconfig.json
tsconfig.test.json
```

The private ESM starter pins `@invokta/core` to the creator version and exports
one deterministic example capability. Its test composes that export into an
engine and invokes it through `engine.invoke`. Generated files are project-owned
and are never updated in place.

The creator does not publish the package, discover dependencies, start an
adapter, or execute a capability.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Help, version, or project creation succeeded |
| `1` | Target safety, filesystem creation, or dependency installation failed |
| `2` | Arguments, project path, or project name were invalid |

Creator diagnostics use `TARGET_INVALID`, `TARGET_UNSAFE`, `TARGET_NOT_EMPTY`,
`SCAFFOLD_CONFLICT`, `WRITE_FAILED`, or `INSTALL_FAILED`. Rejected arguments,
environment values, child errors, stacks, and causes are not included.
