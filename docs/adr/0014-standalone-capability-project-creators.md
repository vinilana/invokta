# ADR 0014: Standalone capability project creators

- Status: Accepted
- Date: 2026-07-29

## Context

Invokta documents two reusable publication forms outside an Action Engine: one
atomic exported capability and one library containing a related set of
capabilities. Authors can copy the repository example, but that example is a
combined workspace fixture rather than a standalone project. The engine creator
does not address these package boundaries because its generated project owns
execution adapters and an engine composition root.

Authors need bounded bootstrap commands for both publication forms without
adding discovery, a registry, package publishing, or another capability
execution path.

## Decision

Invokta publishes two additional native ESM packages:
`create-invokta-capability` and `create-invokta-capability-library`. Each is a
binary-only supporting application exposing an executable of the same name.
This decision supersedes the seven-package count established by ADR 0012 and
ADR 0004 while preserving their dependency direction and package isolation.

The public command surfaces are:

```text
create-invokta-capability <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-capability --help
create-invokta-capability --version

create-invokta-capability-library <project-directory>
  [--package-manager npm|pnpm|yarn] [--no-install]
create-invokta-capability-library --help
create-invokta-capability-library --version
```

Both commands are non-interactive and adopt the target, path, package-manager,
installation, stream, exit-status, diagnostic, rollback, concurrency, and
secret-hygiene contract of `create-invokta-engine`. In particular, targets are
relative, empty, real directories; path arguments are limited to 1,024 Unicode
scalars and 32 non-dot segments; the final project name is lowercase kebab-case
and at most 214 characters; and exclusive writes never replace an existing
entry. The commands expose the same stable diagnostic codes:
`TARGET_INVALID`, `TARGET_UNSAFE`, `TARGET_NOT_EMPTY`, `SCAFFOLD_CONFLICT`,
`WRITE_FAILED`, and `INSTALL_FAILED`.

The atomic creator writes these fixed paths in lexicographic order:

```text
.agents/skills/develop-invokta-project/SKILL.md
.agents/skills/develop-invokta-project/agents/openai.yaml
.gitignore
README.md
package.json
src/capability.ts
src/index.ts
test/capability.test.ts
tsconfig.json
tsconfig.test.json
```

The project root exports one `defineExportedCapability` descriptor with the
literal default ID `onboarding.create-welcome-message`. Its source name is the
generated package name and its source version is `0.1.0`. The test imports the
built project value explicitly, composes it into an engine, and invokes the
effective capability through `engine.invoke`.

The library creator writes these fixed paths in lexicographic order:

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

`AGENTS.md` is a regular UTF-8 text file. `CLAUDE.md` is the relative symbolic
link defined by ADR 0015 rather than a second text file.

Each creator renders the project-specific `develop-invokta-project` workflow
defined by ADR 0016. The atomic and library skills keep their distinct
publication boundaries.

The project root exports one `defineCapabilityLibrary` value containing the
literal default IDs `onboarding.create-welcome-message` and
`onboarding.create-farewell-message`. Its library name is the generated package
name and its version is `0.1.0`. The test imports a selected capability with an
explicit remap, composes it into an engine, and invokes it through
`engine.invoke`.

Both generated manifests are private by default, declare one package-root ESM
export, set `sideEffects` to `false`, and pin `@invokta/core` exactly to the
creator version. They use the same pinned TypeScript, Vitest, Node type, and Zod
versions as the engine creator. Removing `private`, choosing a globally valid
package name, changing source metadata, changing default IDs, and publishing
are deliberate author-owned changes. Generated files are user-owned and are
never upgraded in place.

The creators import no Invokta runtime package and perform no package discovery,
composition, capability execution, adapter startup, registry access, or publish
operation. Their only external process is the optional foreground package
manager install. The creators themselves perform no network request.

The packed acceptance boundary is the generated consumer. Each packed creator
must generate a project that installs from packed release artifacts, type-checks,
tests, builds, exposes only the documented root export, and composes through the
public `@invokta/core` API.

## Consequences

- `npm create invokta-capability@latest my-capability` creates one standalone
  atomic capability project.
- `npm create invokta-capability-library@latest my-library` creates one
  standalone capability-library project.
- `create-invokta-library` is intentionally not published because “library”
  does not identify the Invokta concept being generated.
- Local capability files inside an existing engine remain author-owned; these
  commands do not mutate an existing project.
- Adding templates, interactive prompting, package publication, dependency
  discovery, or in-place generation requires another architectural decision.
