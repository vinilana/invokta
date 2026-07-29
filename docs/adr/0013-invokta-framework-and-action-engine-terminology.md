# ADR 0013: Invokta framework and Action Engine terminology

- Status: Accepted
- Date: 2026-07-29

## Context

The repository used **AI Engine** for both a general architectural concept and
the TypeScript framework that implements it. That overload made it difficult for
the community to discuss independent implementations without appearing to name
this project, and it prevented the framework from having an ownable identity.

The public API already reveals a more precise boundary: consumers invoke stable
domain capabilities through `engine.invoke`, while adapters preserve the same
execution path. The category should describe the domain behavior being
published, and the framework name should identify this implementation.

The package namespace, executable names, deployment manifest, environment
variables, generated files, examples, and documentation are public surfaces.
Renaming only prose would leave users with two brands and an incoherent
installation path. A single pre-release compatibility decision is therefore
required.

As verified on 2026-07-29, none of the six `@ai-engine/*` package names or their
`@invokta/*` replacements is published in the npm registry. The repository has
no released package consumer that requires a compatibility alias.

## Decision

### The category is Action Engines

**Action Engine** replaces **AI Engine** as the framework-neutral category. An
Action Engine publishes reusable, AI-supported domain actions behind stable
contracts while keeping models, prompts, retrieval, data, tools, and execution
mechanisms replaceable.

`docs/action-engines.md` is the community-facing definition of the category. It
defines the qualification test, conceptual boundaries, portable model, and
language that independent projects can reuse. The term does not require Invokta,
TypeScript, MCP, or compatibility approval from this project.

The existing `AE-*` requirement identifiers remain stable and now expand to
**Action Engine**. Renaming identifiers would add churn without changing a
contract or removing ambiguity.

### The framework is Invokta

**Invokta** is the name of this TypeScript framework for building Action Engines.
The framework's public TypeScript vocabulary remains intentionally generic:
`Engine`, `EngineError`, `createEngine`, `defineCapability`, and
`engine.invoke` do not change. Example components such as `support-engine` also
retain the `-engine` suffix because they are Action Engine implementations, not
copies of the Invokta brand.

The repository's package and executable surfaces change atomically:

| Previous surface | Invokta surface |
| --- | --- |
| `@ai-engine/core` | `@invokta/core` |
| `@ai-engine/cli` | `@invokta/cli` |
| `@ai-engine/mcp` | `@invokta/mcp` |
| `@ai-engine/tooling` | `@invokta/tooling` |
| `@ai-engine/installer` | `@invokta/installer` |
| `@ai-engine/deploy` | `@invokta/deploy` |
| `ai-engine` | `invokta` |
| `ai-engine-installer` | `invokta-installer` |
| `ai-engine-deploy` | `invokta-deploy` |
| `ai-engine.deploy.json` | `invokta.deploy.json` |
| `AI_ENGINE_*` | `INVOKTA_*` |
| `.ai-engine-installer.lock` | `.invokta-installer.lock` |

Generated documentation, temporary-file prefixes, test sentinels, registry
fixtures, and example package names adopt the same brand. Source directories and
public TypeScript type names remain stable where they describe the generic
engine abstraction rather than the framework brand.

### This is one pre-release breaking migration

The old package scope, executable aliases, manifest filename, and environment
variables are not retained. Compatibility shims would create two installation
contracts before either has a published consumer and would make future removal
more disruptive. Git consumers must update imports, commands, configuration
filenames, environment variables, and installer lock paths in one change.

The rename does not alter capability inputs, outputs, error codes, invocation
ordering, authorization, events, transports, operational limits, or the single
`engine.invoke` execution path. ADRs 0001 through 0012 remain authoritative for
those decisions. Their historical text is updated to the Invokta names so that
current package instructions remain executable; this ADR records why those
names differ from the original decision history.

External operations remain separate. Renaming the hosted Git repository,
reserving package scopes, acquiring domains, and filing trademarks are not
performed by this repository change.

## Consequences

- The community can discuss and implement Action Engines without adopting the
  Invokta framework.
- Invokta gains one consistent identity across installation, code, commands,
  generated artifacts, and documentation.
- Existing source checkouts using `@ai-engine/*`, `ai-engine-*`, or
  `AI_ENGINE_*` require an atomic migration.
- No runtime semantic migration or capability contract change is required.
- Search, examples, package smoke tests, and documentation validation must reject
  stale old-brand references outside this ADR's migration table and context.
- A future published rename would require deprecation packages, compatibility
  aliases, and a separately versioned migration decision.

## Alternatives considered and rejected

- **Keep AI Engine as both category and framework.** Rejected because the shared
  concept and one implementation remain indistinguishable.
- **Name the category Invokable Engines.** Rejected because “invokable” describes
  a property of the execution boundary rather than the owned domain outcome.
- **Name both the category and framework Invokta.** Rejected because independent
  implementations would appear to claim framework compatibility.
- **Retain the old package scope as aliases.** Rejected because no package has
  been published and aliases would create an unnecessary permanent migration
  surface.
