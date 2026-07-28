# Community capabilities fixture package

This package is a **test fixture**, not a real published package. It exists so
the framework can prove, against real Node package resolution, that one package
may publish capabilities in all three supported forms at once:

| Publication form | Package entry | Default ID |
| --- | --- | --- |
| Atomic root export | `.` | `community.score-ticket-priority` |
| Atomic subpath export | `./classify-ticket` | `community.classify-ticket` |
| Capability library | `./library` | three IDs, see below |

The library bundle publishes `community.summarize-thread`,
`community.search-knowledge-base`, and `community.draft-reply`, in that order.

Nothing here is published to a registry. The package is private, deterministic,
and makes no network or model-provider calls.

## What it demonstrates

- **Atomic exports need no library.** `src/index.ts` and
  `src/classify-ticket.ts` each wrap one `defineCapability` value with
  `defineExportedCapability`. Neither imports the bundle, so an importer that
  uses only the subpath never evaluates `dist/library.js`.
- **Dependencies enter through factories.** Every published value comes from a
  factory that receives engine-owned ports. Nothing is read from
  `ExecutionContext`, a global, or a service locator, and no adapter is started
  at definition or import time.
- **One library factory serves many engines.** `createCommunitySupportLibrary`
  can be called twice with different repositories, classifiers, or knowledge
  bases to build two engines that share no state and return different results.
- **IDs are literal.** Every default ID is a string literal, so the composition
  static gate can observe it in a consuming engine.

## Layout

```text
src/application/ports.ts     repository, classifier, knowledge, permission ports
src/domain/                  ticket and knowledge-article types
src/capabilities/            the five capability definitions
src/index.ts                 package root: one atomic export
src/classify-ticket.ts       ./classify-ticket subpath: one atomic export
src/library.ts               ./library subpath: the capability library
```

The capability definitions know nothing about publication. `defineCapability`
produces them; `defineExportedCapability` and `defineCapabilityLibrary` only add
the default ID and the diagnostic source metadata used for composition.

## Consume it

```ts
import { composeCapabilities, importCapability } from "@ai-engine/core";
import {
  createClassifyTicketExport,
} from "@ai-engine/example-community-capabilities/classify-ticket";

export const capabilities = composeCapabilities({
  imports: [
    importCapability(createClassifyTicketExport(dependencies), {
      as: "operations.classify-ticket",
    }),
  ],
});
```

[`composed-engine`](../composed-engine/) consumes all three forms together.
[The composition guide](../../docs/capability-composition.md) explains the
authoring and consuming workflow.

## Verify the fixture

```sh
yarn workspace @ai-engine/example-community-capabilities test
yarn workspace @ai-engine/example-community-capabilities typecheck
yarn workspace @ai-engine/example-community-capabilities build
```

The tests build `dist/` first, then import the package by its real specifiers
so the `exports` map, not the TypeScript source, is what gets exercised.
