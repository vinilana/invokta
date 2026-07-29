# Action Engines

Community definition

## Purpose

**Action Engine** is shared, framework-neutral vocabulary for a reusable unit of
AI-supported domain behavior. It gives teams a name for the layer that turns a
stable domain contract into an action that agents, applications, automations,
and people can invoke without depending on a particular model, prompt, tool, or
agent harness.

This definition is independent of Invokta. A project does not need to use
Invokta, TypeScript, MCP, or any specific protocol to describe an implementation
as an Action Engine.

## Definition

An **Action Engine** is a versioned software component that publishes one or
more reusable, AI-supported domain actions behind stable, machine-readable
contracts. Models, prompts, retrieval, data sources, tools, and deterministic
algorithms remain replaceable implementation details.

An action states what domain outcome a consumer can request. The engine owns how
that outcome is produced and keeps the same contract available to independent
consumers or execution channels.

A compact definition suitable for reuse is:

> An Action Engine packages reusable, AI-supported domain actions behind stable
> contracts, independently of the agents, applications, and interfaces that
> invoke them.

## Why the category matters

Teams already build Action Engines even when they call them MCP servers, tools,
commands, automations, or agent features. A component that accepts a request,
applies domain rules, uses models or data, and returns a useful domain outcome
already contains the essential action.

The MCP endpoint, command, or HTTP route is a delivery path. The durable value is
the outcome behind it: a reviewed specification, relevant project context, the
next safe workflow step, a classified support ticket, or an approved code
change. Naming the Action Engine boundary makes that outcome independently
reusable and ownable.

Prompts, rules, skills, loops, and graphs are effective places to describe or
coordinate AI behavior. Problems appear when a domain action that began inside
one of those artifacts must serve another consumer. The new consumer often gets
a copied prompt, handler, schema, or policy, and the copies begin to disagree
about valid input, authorization, failures, or what the action actually returns.

AI can make the first transport integration quick to generate, but the team owns
its maintenance. Authentication, schema compatibility, cancellation, error
mapping, protocol upgrades, tests, and observability remain engineering work.
The first additional consumer often exposes assumptions shaped around the
original interface. Teams then have to revisit schemas, authorization, errors,
and business rules, sometimes rebuilding the action around a stable contract.

An Action Engine creates an ownership boundary around the domain outcome. A
support classification action, for example, can keep one contract and one
implementation while serving an agent, a graph node, an application endpoint,
a command-line tool, or a protocol tool. Consumers decide why and when to call
it; the engine owns how the action is validated, authorized, executed, and
reported.

That boundary matters when teams need to:

- reuse one domain action across independent consumers;
- test domain behavior without running an entire agent or orchestration system;
- replace models, prompts, retrieval, providers, or deterministic code behind a
  stable contract;
- review access rules and public failures in one place; and
- assign ownership and version compatibility to the action itself.

An Action Engine is useful when a domain outcome needs to outlive the first
prompt, agent, workflow, or interface that used it. A one-off model call does not
need this boundary unless reuse, independent ownership, or contract stability
becomes valuable.

## Vocabulary

- **Action:** a named, domain-oriented operation with an explicit input, output,
  and failure contract.
- **Capability:** the implementation unit behind an action, including its
  validation, access policy, and execution behavior.
- **Engine:** the versioned owner and execution boundary for one or more actions.
- **Adapter:** a translation layer that exposes the same engine through an
  interface or protocol without reimplementing the action.
- **Consumer:** an agent, application, automation, developer, or person that
  invokes an action.

Projects MAY use different internal names. These terms describe roles, not a
required programming model.

## Qualification test

A component is an Action Engine when all of the following statements are true:

1. **It publishes a domain action.** The public operation describes a meaningful
   outcome such as `support.classify-ticket`, not infrastructure such as
   `llm.complete`.
2. **It has a stable contract.** Inputs, outputs, and public failures are explicit
   and machine-readable.
3. **It enforces the contract at the execution boundary.** Invalid input or
   output fails predictably instead of silently entering or leaving the domain.
4. **It encapsulates its implementation.** A model, provider, prompt, retrieval
   strategy, tool, or deterministic algorithm can change without forcing a
   breaking contract change.
5. **It is independent of one consumer.** The action is not embedded exclusively
   in a particular agent, harness, user interface, or workflow.
6. **It is reusable.** The same domain implementation can serve independent
   consumers or execution channels without duplicating its business behavior.
7. **It has an ownership and versioning boundary.** Consumers can identify what
   owns the action and reason about compatibility over time.

An implementation may satisfy these properties with a library, local process,
service, embedded runtime, or another deployment model.

## Relationship to adjacent concepts

| Concept | Primary responsibility | Relationship to an Action Engine |
| --- | --- | --- |
| Prompt | Supplies instructions and context to a model | May guide a consumer or remain a private implementation detail of a capability; it does not define the engine's stable runtime contract |
| Rule | Expresses a constraint, permission, transformation, or deterministic decision | May control action selection or be enforced as engine access or domain policy; it does not own the complete domain outcome |
| Skill | Packages instructions, knowledge, resources, and sometimes helper scripts for an agent | Can teach an agent when and how to invoke an action while the engine owns validation, access, execution, and failures |
| Loop | Chooses a next step, repeats work, and evaluates a stopping condition | May invoke one or more Action Engines during each iteration while retaining orchestration state and control |
| Graph | Defines nodes, dependencies, branches, and execution order | May use Action Engines as nodes; the graph owns topology while each engine owns its domain action |
| Function | Executes a local code unit | May implement part of a capability but does not by itself establish a reusable versioned boundary |
| Tool | Gives a model or client a callable interface | May expose one action; the engine owns the domain contract and behavior behind it |
| Agent | Chooses goals, actions, and next steps | Consumes Action Engines; it does not need to own their domain behavior |
| Harness | Runs an agent with tools, context, memory, and environment | Hosts or connects consumers to Action Engines |
| Workflow | Coordinates a predefined sequence or graph | May compose actions but should not duplicate their implementation |
| Model gateway | Normalizes access to models or providers | Is infrastructure unless it publishes contracted domain outcomes |

A product can combine several of these responsibilities. The distinction is
architectural: an Action Engine keeps its domain action usable when the agent,
harness, workflow, transport, or AI implementation changes.

### A practical placement test

Use the question the component answers:

- **What should the model know or do?** Put instructions and context in a prompt
  or skill.
- **What is allowed or required?** Express the constraint as a rule.
- **What should happen next, and should execution continue?** Put coordination
  in a graph or loop.
- **What reusable domain outcome can a consumer request?** Publish it through an
  Action Engine.

These are complementary responsibilities. A loop can use a skill to decide that
it should invoke `support.classify-ticket`; the Action Engine then validates the
request, enforces access, performs the classification, and returns the contracted
result. The loop still decides what happens next.

## Portable model

The concept requires no specific API, but every implementation should make the
following information discoverable:

```text
Engine
  name
  version
  actions

Action
  id
  description
  input contract
  output contract
  access rule
  execution behavior
  public failures
```

An invocation follows this conceptual path:

```text
consumer
  -> adapter or direct API
  -> resolve action
  -> validate input
  -> enforce access
  -> execute capability
  -> validate output
  -> return result or stable failure
```

Implementations MAY add concerns such as cancellation, timeouts, events,
authentication adapters, or deployment tooling. Those extensions do not change
the base definition and MUST NOT make the domain action depend on one consumer.

## Naming and publishing guidance

- Prefer engine names based on the owned domain, such as `Support Engine`,
  `Review Engine`, or `Image Engine`.
- Prefer action IDs that combine a domain and an outcome-oriented verb, such as
  `support.classify-ticket` or `review.assess-readiness`.
- Document input, output, public failures, authorization, side effects,
  idempotency, limits, ownership, and versioning.
- Demonstrate at least two independent consumers or execution channels using the
  same action implementation.
- State implementation-specific extensions separately from the shared concept.

A project can describe itself with this copyable statement:

> **[Project] is an Action Engine for [domain]. It publishes [actions] behind
> stable contracts and can be invoked by [consumers or channels].**

## Community use

This project intentionally treats **Action Engine** as shared,
framework-neutral vocabulary. Teams may use the term for independent
implementations without adopting Invokta or requesting compatibility approval.
There is no Invokta certification program and no central registry required to
use the term.

Attribution is welcome when this definition informs another project's
documentation, but attribution is not part of the qualification test. Extensions
should identify themselves as extensions instead of redefining the base term in
a framework-specific way.

## Invokta's relationship to the concept

[Invokta](../README.md) is a TypeScript framework for building Action Engines.
Its `createEngine` and `engine.invoke` contracts, runtime validation, access
rules, CLI adapter, and MCP adapters are one concrete implementation of this
definition. Invokta does not own the category, and an Action Engine does not need
to be compatible with Invokta.

Invokta supplies the reusable framework mechanics so engine authors can focus on
the domain outcome. A capability declares its input, output, access rule, and
execution behavior once, then the same invocation pipeline serves application
code, CLI, MCP stdio, and MCP HTTP. Engine authors keep control of prompts,
models, retrieval, data sources, tools, domain rules, evaluations, and quality.

This makes Invokta suitable for Action Engines that create and review
specifications, retrieve bounded context, guide development workflows, route
work, assess code readiness, or publish another reusable domain action. Each
engine gets the shared contracts and adapters without maintaining a separate
framework implementation for that use case.

Invokta's stricter versioned contracts and limits are documented separately in
[Vision and invariants](./vision-and-invariants.md),
[Architecture and contracts](./architecture.md), and
[scope and limits](./scope-and-limits.md).
