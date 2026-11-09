# Stability policy

This policy defines what Invokta treats as public API, how releases signal
compatibility, how features are deprecated, which platforms are supported, how
security fixes ship, and what must be true before a 1.0 release. It also gives
engine authors rules for evolving their own capability contracts.
[ADR 0046](./adr/0046-stability-policy-capability-deprecation-and-contract-diff.md)
records the decision.

## Current state

- Invokta is pre-1.0. The current release line is `0.9.x`.
- The public packages listed in
  [`scripts/release/release-packages.json`](../scripts/release/release-packages.json)
  are released together from one workflow ([RELEASING.md](../RELEASING.md)),
  always with the same version number.
- Internal dependencies between `@invokta/*` packages are pinned to that exact
  version. Use matching versions of every Invokta package; mixing versions is
  not supported.
- The [changelog](../CHANGELOG.md) follows Keep a Changelog. Each release lists
  its `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`
  entries as applicable.
- No date has been set for 1.0. The [1.0 criteria](#criteria-for-10) below
  describe the required state, not a schedule.

## Public API

Only the surfaces in this table are public. Anything else may change in any
release, including package-internal modules and `dist` file layout,
undocumented exports, error message wording of construction-time `TypeError`s,
log and diagnostic message text, the devtools browser UI, examples (all
examples are private workspace packages), test fixtures, and the documentation
site.

| Package | Public surface |
| --- | --- |
| `@invokta/core` | Every export of the package root, including its TypeScript types; the invocation pipeline order, the `EngineError` codes and `publicDetails` shapes, the event types and fields, `list` and `describe` results, and the construction-time validation limits in [architecture](./architecture.md) |
| `@invokta/cli` | `runCli`, `RunCliOptions`, and `CliIo`; the `list`, `describe`, and `run` grammar; exit codes; the stdout and stderr JSON shapes |
| `@invokta/mcp` | Every export of the package root and of `./web`; the capability-to-tool mapping, including portable tool names, result content, and the `dev.invokta/deprecated` `_meta` key; stdio and HTTP options, defaults, limits, and status behavior; the MCP protocol baseline |
| `@invokta/http` | Every export of the package root and of `./node`; the routes, status mapping, options, defaults, and limits; the structure of the generated OpenAPI document |
| `@invokta/auth-jwt`, `@invokta/otel`, `@invokta/gateway` | Every export of the package root; the documented options, defaults, limits, and, for `@invokta/otel`, span, metric, and attribute names; for `@invokta/gateway`, the declared domain error codes, the discovery capability IDs, and the catalog lock format (`version: 1`) |
| `@invokta/tooling` | The `invokta` commands, arguments, options, and exit codes; the package-root exports; the contract snapshot format (`formatVersion`) and the change codes reported by `contract diff`. The wording of human-readable reports is not public |
| `@invokta/installer` | The `invokta-installer` commands, flags, and exit codes; the `./engine` export; the `invokta.mcp.json` manifest and persisted state formats |
| `@invokta/deploy` | The `invokta-deploy` commands, flags, and exit codes; the package-root and `./scaffold` exports; the deploy manifest format |
| `@invokta/devtools` | The `invokta-devtools` commands, flags, and exit codes; the package-root exports |
| `create-invokta-engine`, `create-invokta-capability`, `create-invokta-capability-library` | The command flags, profiles, and exit codes |

A generated project belongs to its author once it is created. Changing a
creator template affects only projects created afterwards and is not a breaking
change for existing projects.

TypeScript declarations are part of the API. A change is not breaking when it
only affects code that constructs a value the framework produces, such as a
hand-written `Engine` implementation or a literal `CapabilityDescription`:
adding a field to a returned object is a compatible change. Declarations are
validated with the TypeScript version pinned in the repository; other compiler
versions are not tested.

## Versioning

Invokta follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

### Before 1.0

- A minor release (`0.y.0`) may contain breaking changes. Every breaking change
  is listed under `Changed` (or `Removed`) in the changelog with what users
  must do, and a change that reverses a documented boundary is recorded in an
  ADR.
- A patch release (`0.y.z`) contains only compatible fixes, documentation, and
  dependency updates, except for the security exception below.
- When a compatible transition path exists, a breaking change SHOULD be
  preceded by a deprecation in an earlier minor release.

### From 1.0

- A major release is required for any breaking change to the public API.
- A minor release adds compatible functionality: new exports, commands, or
  flags; new optional fields on definitions and options; new fields on returned
  objects; and deprecations.
- A patch release fixes defects so that behavior matches the documentation.
- Breaking changes include: removing or renaming an export, command, flag, or
  option; adding a required field to something users pass in; changing the
  pipeline order, an error code, an event shape, or an exit code; adding a
  member to a closed union that consumers may switch over exhaustively (for
  example `EngineErrorCode`, `EngineEvent["type"]`, or `ExecutionSource`);
  tightening a documented limit; and raising the minimum Node.js version.

## Deprecation

A deprecated public API keeps working until it is removed. Deprecating it
requires all of the following in the same release:

1. a `@deprecated` JSDoc tag on the affected declaration naming the
   replacement, when one exists;
2. a note in the affected reference page; and
3. a `Deprecated` changelog entry with the migration path.

A runtime warning is emitted only through a diagnostic sink the host already
controls, such as the engine logger or a command's stderr; Invokta never writes
deprecation warnings to protocol stdout.

Window:

- Before 1.0, a deprecated API SHOULD remain for at least one subsequent minor
  release.
- From 1.0, a deprecated API MUST remain until the next major release, and the
  deprecation MUST ship in a minor release before that major.
- A security fix may change or remove behavior without a deprecation window.
  The changelog says so in its `Security` entry.

Capabilities published by an engine are deprecated with the capability-level
`deprecated` field described in [engine authors](#guidance-for-engine-authors).

## Supported platforms

- **Node.js.** Every package declares `engines.node`, currently `>=22.20.0`.
  Repository CI runs on the version in `.node-version`, currently `24.20.0`;
  Node.js 22 compatibility is declared but not exercised by CI today. Raising
  the minimum Node.js version is a breaking change: before 1.0 it happens only
  in a minor release, and from 1.0 only in a major release.
- **Module format.** Packages are native ESM only
  ([ADR 0004](./adr/0004-esm-monorepo-and-package-boundaries.md)).
- **MCP protocol.** The baseline revision is `2025-11-25`, implemented through
  the official SDK pinned exactly in `@invokta/mcp`
  ([ADR 0006](./adr/0006-isolated-official-mcp-sdk-and-protocol-2025-11-25.md)).
  Every SDK update is reviewed for protocol support, used subpaths, release
  notes, and security fixes, and must pass the MCP conformance tests. An SDK
  update that keeps the baseline may ship in any release. A baseline change is
  recorded in a new ADR and listed under `Changed`; before 1.0 it ships in a
  minor release. From 1.0, adding support for a newer revision is a minor
  change, and dropping a revision that existing clients still negotiate is a
  major change.

## Security fixes

- Security fixes are released as a new patch version of every package, from the
  latest release line only. Older release lines do not receive backports before
  1.0.
- Each fix is described under `Security` in the changelog without exploit
  details. Dependency updates that address advisories are listed there too.
- CI audits the workspace, documentation, and standalone OAuth example
  dependencies on every pull request.
- Report a suspected vulnerability privately through GitHub private
  vulnerability reporting (**Report a vulnerability** on the repository's
  [Security tab](https://github.com/vinilana/invokta/security)) when it is
  available. Otherwise, open a public issue that only asks the maintainer for a
  private contact channel and contains no vulnerability details. Never put
  vulnerability details in a public issue, discussion, or pull request.

## Criteria for 1.0

Invokta 1.0 will be released when all of the following are true. They describe
a state, not a date.

1. The public API of every package has been reviewed: each export is documented
   and intentionally public, and no known breaking change is pending.
2. At least one minor release has followed this policy, including a
   deprecation completed through its window.
3. CI exercises every supported Node.js major version.
4. Private vulnerability reporting is enabled, and a security policy file
   describes it and the supported release lines.
5. Release verification detects unintended changes to each package's exported
   names.
6. The official examples gate their capability contracts with
   `invokta contract diff` in the repository checks.
7. The MCP SDK review and conformance process of ADR 0006 passes on the
   baseline at the time of release.

## Guidance for engine authors

An engine's `version` and its capability contracts are owned by the engine
author. Version an engine with SemVer and treat each capability as a public
contract: its ID, input and output schemas, access kind, timeout, and
annotations. A removed or renamed capability ID breaks every caller that uses
it.

### Adding output properties

Invokta publishes output schemas as the schema library produces them, and Zod
closes every output object with `additionalProperties: false`. A consumer that
validates results against the schema it received therefore rejects a property
it has not seen. The official MCP SDK client, which `connectMcpClient` uses,
caches each tool's output schema from `tools/list` and fails every call to that
tool after a deploy that adds an output property, until it lists tools again.
The stateless MCP HTTP adapter does not send `tools/list_changed`
notifications, so the client is not told to refresh.

Adding a property to a closed output object is therefore potentially breaking.
Release it in a minor version of the engine with a changelog notice, and have
MCP clients list tools again (for example by reconnecting) after the deploy.
Direct callers that ignore unknown properties are unaffected. Adding a property
to an output object whose schema already allowed additional properties is
compatible.

### What counts as a breaking change

| Change | Classification |
| --- | --- |
| Remove a capability, or rename its ID | Breaking |
| Add a required input property, or make an optional one required | Breaking |
| Narrow an input: remove a type, an enum value, or a const; add or tighten a bound or `pattern`; require unique items; reject additional properties | Breaking |
| Remove an output property, or make a required one optional | Breaking |
| Widen an output: add a type or an enum value, relax a bound | Breaking |
| Change access from `public` to `authenticated` or a function rule | Breaking |
| Change what an existing field means without changing its schema | Breaking, and not detectable by tooling |
| Add or shorten a timeout | Potentially breaking |
| Lose a behavioral hint guarantee: `readOnly` true to false, `destructive` false to true, `idempotent` true to false, or `openWorld` false to true | Potentially breaking |
| Switch access between `authenticated` and a function rule | Potentially breaking |
| Remove an optional input property from a schema that still accepts additional properties | Potentially breaking |
| Add an output property to a closed output object (`additionalProperties: false`, which Zod emits for every output object), or let a closed output object accept additional properties | Potentially breaking: see [adding output properties](#adding-output-properties) |
| Add a property whose values were previously governed by an `additionalProperties` schema (a Zod `catchall`) or `patternProperties`, with a different schema | Potentially breaking |
| Change `anyOf`, `oneOf`, `allOf`, `not`, `if`, `$ref`, `$defs`, `patternProperties`, `format`, `default`, or replace a `pattern` | Potentially breaking: review manually |
| Change anything inside a union or discriminated union, which Zod emits as `anyOf` or `oneOf` | Potentially breaking: review manually. A nullable value (`anyOf: [S, { type: "null" }]`) is compared through `S` |
| Rename the engine | Potentially breaking: it is the MCP server identity |
| Remove a declared domain error code, or stop sending its details | Breaking |
| Change a declared error's `retryable` flag | Potentially breaking |
| Change a declared error's details schema | Classified like an output schema |
| Add a declared domain error code, or add details to one | Compatible |
| Add a capability, or add an optional input property | Compatible, assuming callers did not already send that property with another type |
| Widen an input, narrow an output, make an input property optional, add an output property to an object that allows additional properties | Compatible |
| Deprecate a capability, or change titles, descriptions, and examples | Compatible |

Handler behavior, a function access rule's logic, latency, cost, and the model
or provider behind a capability are not visible in the contract. Review them
separately; the replaceable implementation invariant (AE-INV-03) still requires
that they do not break compatibility.

### Deprecate before removing

1. Add `deprecated: { reason, since, replacement }` to the capability. The
   notice appears in `list`, `describe`, the CLI, and the MCP tool listing, and
   invocation behavior does not change.
2. To rename a capability, register the same definition under the new ID and
   mark the old ID deprecated with the new ID as `replacement`.
3. Remove the deprecated ID in the next major version of the engine.

### Gate releases in CI

`@invokta/tooling` captures and compares contracts without invoking a
capability:

```sh
invokta contract snapshot dist/engine.js --output contract.next.json
invokta contract diff contract.json contract.next.json
```

`contract diff` exits `1` when it finds a breaking change and, with
`--fail-on-potentially-breaking`, also for potentially breaking changes. Commit
the accepted `contract.json` and update it deliberately when a release changes
the contract. Changes the comparison cannot decide are reported as potentially
breaking rather than guessed compatible. Engines whose schemas use unions,
discriminated unions, `$ref`, or other composition keywords should run
`contract diff` with `--fail-on-potentially-breaking` so those changes are
reviewed before release.
