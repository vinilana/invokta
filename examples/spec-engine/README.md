# Spec engine example

This example runs a spec-driven development workflow — specify, plan, break
down, implement with evidence, review — as five capabilities published through
the direct API, CLI, MCP stdio, and stateless MCP HTTP:

| Capability | Step | Allowed stages |
| --- | --- | --- |
| `spec.create-specification` | Turn an intent into a reviewable specification | (new identifier) |
| `spec.plan-implementation` | Derive the technical plan | `drafted` |
| `spec.break-down-tasks` | Derive the executable task list | `planned` |
| `spec.complete-task` | Record one task as implemented, with evidence | `tasked`, `implementing` |
| `spec.get-workflow-status` | Report the state and the capability to run next | any |

## The framework has no workflow engine

Invokta deliberately excludes orchestration: no queue, scheduler, saga,
retry policy, or step runner (`docs/scope-and-limits.md`, AE-LIMIT-01 and
AE-LIMIT-02). This example shows that a real workflow does not need one.

- **Ordering is a domain rule.** `src/domain/workflow.ts` owns the stages and the
  transitions each step allows. A step invoked out of order fails with a safe
  `EXECUTION_FAILED` error carrying `{ specId, stage, expectedStages }`.
- **Each step is one invocation.** No capability calls another capability; the
  caller — a script, an agent, an MCP host, or `src/direct.ts` — decides what to
  invoke next, and `spec.get-workflow-status` publishes `nextCapability` so the
  caller does not have to model the workflow itself.
- **State lives in a port.** `SpecificationStore` holds the workflow record with
  a revision. Two writers that started from the same revision cannot both win:
  the loser receives "The specification changed during this invocation."
- **Every step is authorized on its own.** `spec:create`, `spec:plan`,
  `spec:break-down`, `spec:implement`, and `spec:read` are separate permissions,
  so an implementer principal cannot rewrite the specification it is
  implementing.

## Architecture

```text
direct / CLI / MCP stdio / MCP HTTP
                |
                v
           engine.invoke        (one step per invocation)
                |
                v
   spec.* capability  ->  stage guard (domain)
       |                       |
       v                       v
 SpecificationStore     SpecificationAuthor        WorkflowPermissionChecker
   (revisioned)          (model-backed port)        (per-step permissions)
```

- `src/domain/specification.ts` owns the record types.
- `src/domain/workflow.ts` owns the stages, transitions, task completion rule,
  and the next-capability rule.
- `src/application/ports.ts` owns the store, author, and permission interfaces.
- `src/capabilities/` owns the Zod 4 contracts, access rules, timeouts, and
  handlers; `workflow-contract.ts` holds the shared schema fragments and safe
  workflow errors.
- `src/infrastructure/` contains deterministic adapters for local use.
- `src/engine.ts` is the composition root.

The bundled `SpecificationAuthor` is a deterministic template, so the example
runs without a model provider. Replace it with a prompt-and-model
implementation that honors the supplied `AbortSignal`; no contract changes.

## Run the example

From the repository root, build the framework packages first:

```sh
yarn build
```

Run the full workflow in one process:

```sh
node examples/spec-engine/dist/direct.js SPEC-DEMO
```

The direct entrypoint invokes `create → plan → break down → complete each task →
status` and prints the delivered workflow record.

Use the CLI, one step per command:

```sh
node examples/spec-engine/dist/cli.js list
node examples/spec-engine/dist/cli.js describe spec.complete-task
node examples/spec-engine/dist/cli.js run spec.get-workflow-status --input '{"specId":"SPEC-1"}'
node examples/spec-engine/dist/cli.js run spec.plan-implementation --input '{"specId":"SPEC-1"}'
```

The store is process-local: every process starts from the seeded `SPEC-1`
specification in `src/engine.ts`, so a CLI command never observes the previous
command's write. Inject a durable `SpecificationStore` to keep a workflow across
processes; nothing else changes.

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/spec-engine/dist/mcp-stdio.js
```

A single stdio session keeps its workflow state, so an agent can specify, plan,
break down, and implement across several tool calls.

Start the stateless MCP HTTP adapter on the loopback default:

```sh
SPEC_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/spec-engine/dist/mcp-http.js
```

The HTTP entrypoint requires a bearer token and never reads identity from the
tool input. Its literal token comparison is a deterministic demonstration of the
framework's authentication hook, not production identity.

## Evidence is part of the contract

`spec.complete-task` requires non-empty `evidence`, such as the command that
proves the task. A task cannot be completed twice, and an unknown task
identifier fails with `{ specId, taskId }` in `publicDetails`. The workflow
reaches `delivered` only when every task carries evidence.

## Verify the example

```sh
yarn workspace @invokta/example-spec test
yarn workspace @invokta/example-spec typecheck
yarn workspace @invokta/example-spec build
```

## Inspect and gate this engine

```sh
yarn workspace @invokta/example-spec devtools
yarn workspace @invokta/example-spec devtools:doctor
yarn workspace @invokta/example-spec check:mcp
```

`devtools` rebuilds on change and serves the engine on the printed
`http://localhost:<port>/` URL. Its Playground emulates one call through the
direct, CLI, MCP stdio, or MCP HTTP path under the development `Principal` you
select, and records what that adapter exchanged. `devtools:doctor` runs the
read-only engine checks and reports whether an `invokta.mcp.json` manifest sits
next to the project. `check:mcp` is the build-time conformance gate from
[ADR 0026](../../docs/adr/0026-generated-engine-mcp-conformance-gate.md): it
fails when two capability IDs derive the same portable MCP tool name, before an
adapter starts or the engine is installed.
