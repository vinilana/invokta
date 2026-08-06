# @invokta/devtools

Development-time engine dev server, web inspector, and doctor diagnostics for
Invokta. This package contributes no runtime contract, capability, adapter, or
transport. It depends only on the public APIs of `@invokta/core` and
`@invokta/mcp` and Node built-ins, and no runtime package depends on it.

## invokta-devtools doctor

```text
invokta-devtools doctor <esm-module> [--export <name>]
```

Read-only development checks for a built engine module.

- `<esm-module>` is resolved against the current working directory and must
  already be built to ESM. Importing the module executes it.
- `--export <name>` selects the export to inspect. It defaults to `engine`,
  the documented composition-root convention.

The doctor verifies that the export is an engine, reads every capability
summary and description, and checks that the published JSON Schemas are
readable. Missing titles or annotations and the presence of the
`invokta.mcp.json` manifest are reported as advisory notes. The doctor never
invokes a capability, starts a transport, or mutates the filesystem.

### Exit codes

| Exit | Meaning |
| ---: | --- |
| `0` | The engine passed the checks; notes may be reported |
| `1` | The doctor reported findings |
| `2` | Invalid usage, a load failure, a missing export, or a non-engine export |

Diagnostics are deterministic, stack-free, and written only to `stderr`.

The dev server contract is specified in the
[engine devtools dev server specification](../../docs/specs/engine-devtools-dev-server.md)
and chartered by [ADR 0020](../../docs/adr/0020-engine-devtools-dev-server.md).
