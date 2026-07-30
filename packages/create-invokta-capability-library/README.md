# create-invokta-capability-library

Create a standalone TypeScript package that publishes a related set of Invokta
capabilities through `defineCapabilityLibrary`.

## Commands

```text
create-invokta-capability-library <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-capability-library --help
create-invokta-capability-library --version
```

The npm initializer shorthand resolves to this package:

```sh
npm create invokta-capability-library@latest my-library
```

Creation is non-interactive. The target must be a relative absent or empty real
directory. Existing files and symbolic-link path components are refused and
never overwritten.

The invoking package manager is inferred from `npm_config_user_agent`, with npm
as the fallback. Use `--package-manager` to choose explicitly or `--no-install`
to generate files without starting a package manager or performing network I/O.

## Generated project

```text
.agents/skills/develop-invokta-project/SKILL.md
.agents/skills/develop-invokta-project/agents/openai.yaml
.gitignore
AGENTS.md
CLAUDE.md -> AGENTS.md
README.md
package.json
src/capabilities/create-farewell-message.ts
src/capabilities/create-welcome-message.ts
src/index.ts
test/library.test.ts
tsconfig.json
tsconfig.test.json
```

The generated `develop-invokta-project` skill teaches an agent to preserve
literal default IDs and the library publication boundary, evolve contracts with
RED/GREEN/REFACTOR, and prove selection and remapping through
`importCapabilities` and `engine.invoke`. Its metadata includes a ready-to-use
`$develop-invokta-project` prompt.

`AGENTS.md` documents the starter's capability-contract and test-first delivery
constraints. `CLAUDE.md` is a real relative symbolic link to that file, keeping
agent instructions in one source of truth. If the filesystem cannot create the
link, creation fails and rolls back instead of copying the instructions.

The private ESM starter pins `@invokta/core` to the creator version and exports
one deterministic example library. Its test selects and remaps one capability,
then invokes it through `engine.invoke`. Generated entries are project-owned
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
