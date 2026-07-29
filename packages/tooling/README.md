# @invokta/tooling

Development-time command line tooling for Invokta. This package
contributes no runtime contract, capability, adapter, or transport. It depends
only on the public composition API of `@invokta/core` and Node built-ins, and
no runtime package depends on it.

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
