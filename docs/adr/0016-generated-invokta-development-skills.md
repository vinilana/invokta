# ADR 0016: Generated Invokta development skills

- Status: Accepted
- Date: 2026-07-30

## Context

The three project creators produce runnable examples and short READMEs, but an
agent changing a generated project also needs the non-obvious Invokta workflow:
which contracts are public, where dependencies enter, how composition differs
between project types, and which execution boundary proves behavior.

A single generic guide for every project type would blur important boundaries.
An Action Engine owns execution adapters, an atomic capability publishes one
descriptor, and a capability library publishes an ordered set of default IDs.
The guidance must remain available to an agent without adding a runtime skill,
plugin system, registry, or framework dependency.

## Decision

`create-invokta-engine`, `create-invokta-capability`, and
`create-invokta-capability-library` each add this valid generated skill package:

```text
.agents/skills/develop-invokta-project/SKILL.md
.agents/skills/develop-invokta-project/agents/openai.yaml
```

The skill name is `develop-invokta-project`. `SKILL.md` contains only the
required `name` and `description` YAML frontmatter fields, followed by concise
imperative workflow instructions. `agents/openai.yaml` contains deterministic
`display_name`, `short_description`, and `default_prompt` interface metadata.
The default prompt explicitly names `$develop-invokta-project`. The skill has no
scripts, references, assets, tool dependencies, or network behavior.

Every variant instructs the agent to establish the public contract, follow RED,
GREEN, REFACTOR, preserve the generated project's scope, and run the selected
package manager's `check` command before completion.

The Action Engine variant additionally requires domain-oriented capabilities,
explicit schemas and access, engine-owned dependency injection, stable
registration IDs, and one `engine.invoke` path for direct, CLI, and MCP entry
points. It prohibits adapter-specific business logic and framework-wide
registries or service locators.

The atomic capability variant keeps the capability definition separate from its
`defineExportedCapability` publication descriptor. It treats the default ID,
source metadata, schemas, access rule, and package export as compatibility
surfaces. Its acceptance workflow composes with `importCapability` and invokes
through `engine.invoke`; it adds no adapter or engine entry point.

The capability-library variant keeps each capability definition independent and
publishes literal, ordered default IDs through `defineCapabilityLibrary`. It
treats the library name, version, IDs, schemas, access rules, and package export
as compatibility surfaces. Its acceptance workflow selects or remaps through
`importCapabilities`, composes an engine, and invokes through `engine.invoke`;
it adds no adapter, discovery, or registry behavior.

The skill and its metadata are deterministic UTF-8 text entries governed by the
existing exclusive-write and rollback contract. They are guidance for changing
the generated project and never execute, import the project, call a capability,
or alter the Invokta runtime architecture. Template changes affect only future
generated projects; all generated skill files become user-owned immediately.

Release verification must inspect all three packed creator outputs, validate
the skill structure, reject unresolved template placeholders, and confirm the
project-type boundary named by each variant.

## Consequences

- An agent entering any generated project can discover a focused Invokta
  development workflow without first knowing the framework documentation.
- All three creators add two nested deterministic text files and their parent
  directories to the existing scaffold transaction.
- The shared skill name provides one invocation convention while tailored
  content prevents execution-adapter guidance from leaking into capability
  packages.
- The generated skill is not an Invokta runtime primitive and creates no new
  extension, discovery, or execution mechanism.
