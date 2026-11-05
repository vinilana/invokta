# @invokta/tooling

Development-time command line tooling for Invokta. This package contributes no
runtime capability, adapter, or transport. It delegates composition validation
to `@invokta/core` and MCP catalog validation to `@invokta/mcp`, and captures
contracts only through `engine.list` and `engine.describe`; no runtime package
depends on it.

## invokta check-capabilities

```text
invokta check-capabilities <esm-module> [--export <name>]
```

The build gate for collision-safe capability composition. It imports a built ESM
module, which is what runs `composeCapabilities`, and reports the outcome. The
command never re-implements validation, never invokes a capability, and never
starts an adapter or transport.

- `<esm-module>` is resolved against the current working directory and must
  already be built to ESM. A dedicated, side-effect-free composition module is
  recommended, because importing the module executes it.
- `--export <name>` selects the export to inspect. It defaults to
  `capabilities`.

The selected export must be the value returned by `composeCapabilities`. A raw
map assembled with object spread is rejected: the spread has already discarded
the declaration boundaries, so no collision guarantee can be made for it.

### Exit codes

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | The selected export is a valid tracked composition.                                                        |
| `1`  | The composition reported issues. Every issue is reported in one run.                                       |
| `2`  | Invalid usage, a module that failed to load, a missing export, or an export that is not a tracked composition. |

All diagnostics go to `stderr`. The command writes nothing to `stdout` on any
code path, so it composes with shell pipelines that capture program output.

### Diagnostics

Diagnostics are line oriented and deterministic. Collision issues come first,
sorted by effective ID; the remaining issues follow in composition order. Every
value is emitted as a JSON string literal so that an identifier containing
whitespace or a newline cannot forge a diagnostic line.

```text
invokta: the capability composition is invalid.
module: "dist/capabilities.js"
export: "capabilities"
issues: 2
issue: code="CAPABILITY_ID_COLLISION" effectiveId="support.summarize" declarations=2
  declaration: kind="local" localId="support.summarize"
  declaration: kind="atomic" sourceName="@community/support-capabilities" sourceVersion="2.1.0" defaultId="support.summarize"
issue: code="CAPABILITY_IMPORT_ID_NOT_FOUND" libraryName="@community/tickets" defaultId="tickets.unknown"
```

Diagnostics carry only effective IDs, default IDs, and declared provenance
strings. They never carry a schema, handler, input, output, dependency value, or
credential.

### Continuous integration

Run the command for every engine that composes imported capabilities, after the
application has been built:

```bash
invokta check-capabilities dist/capabilities.js
```

## invokta check-mcp

```text
invokta check-mcp <esm-module> [--export <name>]
```

The build-time MCP catalog preflight. It imports a built ESM module, selects the
`engine` export by default, and runs the same catalog construction used by MCP
stdio and HTTP without starting an adapter or invoking a capability.

Domain IDs such as `tasks.create` remain valid. The command validates their
derived public aliases and exits `1` when two IDs collide, for example
`support.echo` and `support_echo` both becoming `support_echo`. The diagnostic
contains only the stable issue code, tool name, and colliding capability IDs.
Usage, loading, export, and invalid-engine failures exit `2`; success is silent.

```bash
invokta check-mcp dist/engine.js
invokta check-mcp dist/application.js --export supportEngine
```

## invokta contract

```text
invokta contract snapshot <esm-module> [--export <name>] [--output <file>]
invokta contract diff <previous-snapshot> <next-snapshot> [--fail-on-potentially-breaking]
```

The capability contract release gate
([ADR 0046](../../docs/adr/0046-stability-policy-capability-deprecation-and-contract-diff.md)).
`snapshot` imports a built ESM module, selects the `engine` export by default,
and writes a deterministic JSON snapshot of its public contract to stdout or to
`--output`: `formatVersion` `1`, the engine name and version, and each
capability's title, description, access kind, timeout, annotations, deprecation
notice, and input and output JSON Schemas. Object keys are sorted by code unit
(JSON serialization still writes integer-like keys such as `"9"` and `"10"`
first, in numeric order), and the set-valued `required`, `type`, and `enum`
arrays are sorted, so reordering properties, keywords, required names, or enum
members never changes the bytes. No capability is invoked.

`diff` compares two snapshots and writes a report to stdout:

```text
invokta: contract diff
previous: engine="support-engine" version="1.0.0" capabilities=2
next: engine="support-engine" version="2.0.0" capabilities=2

breaking changes: 2
  REQUIRED_CHANGED capability="support.classify" at="input#/properties/priority": The property is now required.
  CAPABILITY_REMOVED capability="support.close": The capability was removed.

potentially breaking changes: 1
  TIMEOUT_CHANGED capability="support.classify": A timeout of 1000 ms was added.

compatible changes: 1
  CAPABILITY_ADDED capability="support.reopen": The capability was added.

result: breaking changes found
```

Narrowing an input or widening an output is breaking; the opposite is
compatible. Adding an output property to a closed object
(`additionalProperties: false`, which Zod emits for every output object) is
potentially breaking (`CLOSED_OUTPUT_PROPERTY_ADDED`): MCP SDK clients validate
results against their cached `tools/list` schema and reject the new property
until they list tools again. A property added where an `additionalProperties`
schema or `patternProperties` previously applied is potentially breaking unless
its schema is identical. Nullable values (`anyOf: [S, { type: "null" }]`) are
compared through `S`. A change the comparison cannot decide, such as `$ref`,
other `anyOf` or `oneOf` unions, `allOf`, `not`, `format`, `default`, or a
replaced `pattern`, is potentially breaking; engines that rely on them should
pass `--fail-on-potentially-breaking`. The
[stability policy](../../docs/stability-policy.md#guidance-for-engine-authors)
lists every rule.

| Code | Meaning |
| ---- | ------- |
| `0`  | The snapshot was written, or no breaking change was found |
| `1`  | A breaking change was found, or a potentially breaking change with `--fail-on-potentially-breaking` |
| `2`  | Invalid usage, a module or export failure, or an unreadable or invalid snapshot |

Snapshot files are limited to 16 MiB and 256 levels of schema nesting. Unknown
snapshot fields are rejected, JSON parser messages are never echoed, echoed
keys and capability IDs are truncated to 64 characters, and control and format
characters are escaped in every diagnostic and report.

```bash
invokta contract snapshot dist/engine.js --output contract.next.json
invokta contract diff contract.json contract.next.json
```

## Programmatic API

```ts
import { checkCapabilities } from "@invokta/tooling";

const exitCode = await checkCapabilities({
  argv: ["check-capabilities", "dist/capabilities.js"],
  cwd: process.cwd(),
});
```

`checkCapabilities` resolves with the exit code and writes diagnostics through
the injectable `io.writeStderr` sink. It never terminates the process.

The package also exports `checkMcp`, `CheckMcpIo`, `CheckMcpOptions`,
`runContractCommand`, `ContractCommandIo`, and `ContractCommandOptions` with the
same process-free calling convention:

```ts
import { checkMcp } from "@invokta/tooling";

const exitCode = await checkMcp({
  argv: ["check-mcp", "dist/engine.js"],
  cwd: process.cwd(),
});
```

`createContractSnapshot(engine)`, `serializeContractSnapshot(snapshot)`, and
`diffContractSnapshots(previous, next)` expose the same contract gate to tests:

```ts
import {
  createContractSnapshot,
  diffContractSnapshots,
} from "@invokta/tooling";

const diff = diffContractSnapshots(baseline, createContractSnapshot(engine));
if (diff.breaking > 0) throw new Error("The capability contract broke.");
```
