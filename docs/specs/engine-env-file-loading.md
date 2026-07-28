# Engine environment file loading

- Status: Draft
- Target: Post-v0.1
- Change type: Additive convention and scaffold expansion; no runtime package change
- Date: 2026-07-28

## Summary

Engine composition roots already configure themselves from the process
environment: bearer tokens, provider credentials, bind hosts, ports, and
allowlists all enter through `process.env` and are passed to `createEngine`
factories or adapter options. What is missing is a standard way to populate
that environment during local development. Today every author either exports
variables by hand, invents a shell wrapper, or adds an ad-hoc `dotenv`
dependency with its own precedence and parsing quirks.

This specification defines one convention for loading environment files and
one generated implementation of it:

- a canonical, opt-in `.env` file at the engine project root, parsed with
  Node's built-in `util.parseEnv`, applied before any configuration is read,
  and never overriding a variable the real environment already defines;
- required-variable validation that fails startup closed, naming missing
  variables without printing any value;
- scaffold support in the HTTP engine build and deploy toolkit
  (`docs/specs/http-engine-build-and-deploy.md`): `ai-engine-deploy init`
  additionally generates a `src/env.ts` loader module and a secret-free
  `.env.example` derived from the deployment manifest's declared names.

Environment files are a development convenience, not a deployment mechanism.
A production deployment injects real environment variables through its
platform; the deployment package already excludes every `.env*` file from
the container build context, so a production image never contains one.

## Relationship to the existing architecture

This specification changes no runtime package and adds no runtime API:

- `@ai-engine/core`, `@ai-engine/cli`, and `@ai-engine/mcp` are not
  modified. ADR 0001's hexagonal boundary holds: reading files and mutating
  `process.env` are I/O concerns owned by the application composition root,
  never by the core or an adapter.
- The single `engine.invoke` execution path of ADRs 0003 and 0005 is
  untouched. Loading happens before an engine exists; no pipeline stage,
  event, or error code is added. The seven-code `EngineError` taxonomy is
  unchanged: an environment failure is a composition-root startup failure
  that occurs before any invocation.
- Parsing is pinned to the Node.js standard library (`util.parseEnv`,
  available at the repository floor of Node.js `>=22.20.0`). No `dotenv` or
  other third-party dependency is introduced anywhere.
- The generated loader is application code emitted by `@ai-engine/deploy`'s
  `init` command. This specification therefore amends the scaffold contract
  of `docs/specs/http-engine-build-and-deploy.md` (its `init` file set and
  `DEPLOYMENT.md` content) and is governed by the same authorizing ADR. It
  adds no package and widens no package's dependency rules.
- The convention applies to every composition root — direct, CLI, MCP
  stdio, and MCP HTTP — because all four read configuration from
  `process.env`. First-release scaffolding generates the loader alongside
  the HTTP entry point; other roots import the same generated module or copy
  the documented pattern.

## Goals

1. Give every engine one documented, deterministic way to load local
   environment values with clear precedence.
2. Guarantee that a value present in the real environment always wins, so a
   forgotten `.env` file can never override CI, container, or platform
   configuration.
3. Fail startup closed — with names only, never values — when a declared
   required variable is missing or an environment file is unsafe.
4. Ship the convention as generated, user-owned application code with zero
   new dependencies.
5. Keep environment files out of version control history, container images,
   diagnostics, and logs by construction.

## Non-goals

- Profile or layer systems: `.env.local`, `.env.production`,
  `.env.<mode>`, or merge chains across multiple files.
- Variable expansion, interpolation, command substitution, or templating
  beyond what `util.parseEnv` itself defines.
- Encrypted environment files, secret managers, keychains, or remote
  configuration services.
- A runtime configuration API, typed config schema, or validation beyond
  presence checks in `@ai-engine/core` or any adapter.
- Watching, hot reload, or re-reading the file after startup; a process
  reads its environment once.
- Loading inside `@ai-engine/cli` or `@ai-engine/mcp`; adapters receive an
  already-configured process.
- Writing to, migrating, or synchronizing environment files. The toolkit
  generates only the example file; the real `.env` is always user-authored.

## Terminology

**Environment file**
: A plain-text file of `KEY=value` pairs in the dialect parsed by Node's
  `util.parseEnv`. The canonical default is `.env` at the engine project
  root.

**Loader**
: The generated `src/env.ts` module (or a hand-written equivalent following
  this contract) that reads one environment file and applies it to
  `process.env` at the very start of a composition root.

**Declared required names**
: The environment variable names the engine needs to start, taken from the
  deployment manifest's `env.required` list when the toolkit is used.

**Override variable**
: `AI_ENGINE_ENV_FILE`, the documented way to point the loader at a
  non-default environment file path.

## Loading contract

**AE-ENV-LOAD-01 — Composition root, first, once.** The loader runs in the
composition root, synchronously, exactly once per process, before any other
module reads configuration from `process.env`. It is opt-in per entry point:
an engine that does not import the loader keeps today's behavior
unchanged.

**AE-ENV-LOAD-02 — Canonical path and override.** The default file is
`.env` resolved against the process working directory. When
`AI_ENGINE_ENV_FILE` is set and non-empty, its NUL-free path — absolute, or
relative to the process working directory — replaces the default. The
override designates a file, never a directory.

**AE-ENV-LOAD-03 — Missing-file asymmetry.** A missing default `.env` is a
silent no-op: local files are optional and production is expected not to
have one. A missing, unreadable, or non-regular file named by
`AI_ENGINE_ENV_FILE` is a startup failure: an explicit request must not
degrade silently.

**AE-ENV-LOAD-04 — Real environment wins.** The loader never overrides,
deletes, or mutates a variable already present in `process.env`, including
one present with an empty string value. It only adds absent keys. Precedence
is therefore fixed: process environment, then environment file, then the
composition root's own defaults.

**AE-ENV-LOAD-05 — Parsing is pinned to the platform.** File content is
decoded as UTF-8 and parsed with `util.parseEnv`. The loader MUST NOT
implement its own dialect, support additional syntax, or post-process
values. Behavior for comments, quoting, and whitespace is exactly the
platform parser's documented behavior for the pinned Node.js floor.

**AE-ENV-LOAD-06 — Key validation fails closed.** Every key the loader
would apply MUST match `^[A-Z_][A-Z0-9_]{0,127}$`. A non-matching key aborts
startup naming only that key. Keys are not silently skipped: a typo in an
environment file surfaces as an error, not as a mysteriously absent
variable. Keys that already exist in the process environment are exempt from
this check because they are never applied.

**AE-ENV-LOAD-07 — File safety.** The environment file MUST be a regular,
non-symlink file of at most 65,536 encoded bytes containing no NUL byte.
The loader resolves and checks the path itself; it MUST NOT follow a
symlink to content outside the author's intent. A violation aborts startup.

**AE-ENV-LOAD-08 — Bounded application.** At most 256 keys may be applied
from one file; each value is at most 4,096 Unicode scalar values after
parsing. Exceeding either bound aborts startup with the count, never the
content.

## Required-variable validation

**AE-ENV-REQ-01 — Presence check after loading.** After the loader runs,
the composition root verifies that every declared required name is present
and non-empty in `process.env`. On failure it writes one diagnostic listing
the missing names — names only, no values, no partial values — to `stderr`
and exits non-zero without constructing the engine or starting an adapter.

**AE-ENV-REQ-02 — Names come from the manifest.** When the deploy toolkit
is used, the scaffolded check is generated from the deployment manifest's
`env.required` list, so the manifest, the generated `.env.example`, the
generated `DEPLOYMENT.md`, and the startup check cannot disagree. A
hand-written composition root supplies its own literal name list under the
same rules.

**AE-ENV-REQ-03 — Presence is not validity.** The check proves presence and
non-emptiness only. Semantic validation of values remains where it already
lives: adapter option validation, capability input schemas, and the
authentication hook.

## Startup failure contract

These are stable composition-root failures, not toolkit errors and not
`EngineError` values. Each writes one sanitized line to `stderr`; the
process exits with a non-zero status and starts nothing.

| Condition | Stable message |
| --- | --- |
| Override path missing or not a regular file | `The configured environment file was not found.` |
| Symlink, NUL, oversize, or undecodable file | `The environment file is unsafe to load.` |
| Parse failure reported by the platform parser | `The environment file could not be parsed.` |
| Applied key fails the name pattern | `The environment file contains an invalid variable name.` |
| Key or value bound exceeded | `The environment file exceeds a load limit.` |
| Declared required variable absent or empty | `A required environment variable is missing.` |

A diagnostic MAY name the resolved file path, the offending key, or the
missing variable names. It MUST NOT include any value, any file content, a
stack trace, or a cause chain.

## Scaffold integration

This section amends `docs/specs/http-engine-build-and-deploy.md`.

### `init` additions

`ai-engine-deploy init` additionally generates, when absent and under the
same never-overwrite rule:

| File | Content |
| --- | --- |
| `src/env.ts` | The loader and `requireEnvironment` check implementing this contract with Node built-ins only. User-owned after the first write, like the other source scaffolds. |
| `.env.example` | One line per declared manifest name (`required` first, then `optional`, each group in declaration order) with an empty value and a comment marking the required group. Secret-free by construction; safe to commit. |

The generated `src/mcp-http.ts` imports `src/env.ts` as its first
side-effectful import and calls the required-name check before constructing
the engine. The generated `src/env.ts` is entry-point-agnostic so CLI,
stdio, and direct roots can import the same module.

### `package` and documentation additions

- `.dockerignore` already excludes `.env*`; that exclusion is now normative
  for this contract as well: a deployment package MUST NOT copy any
  environment file into an image.
- `deploy/DEPLOYMENT.md` MUST document the precedence order, state that
  `.env` is a local development file, and instruct operators to inject
  production values through the platform.
- `.env.example` regeneration follows `package`'s marker policy when the
  manifest's declared names change; `.env` itself is never generated,
  read, or validated by the toolkit. Only the running engine reads it.
- The getting-started guide gains a short section presenting the convention
  for engines that do not use the toolkit.

## Security and trust

- An environment file is local trusted input with the same standing as the
  shell environment; the loader adds no sandbox and grants nothing the
  process could not already read.
- Values never appear in diagnostics, logs, events, generated files, or
  error causes. Only names may be reported.
- `.env` MUST be ignored by version control. The specification makes the
  committed artifact `.env.example`, which contains names only. The toolkit
  does not edit `.gitignore` (it never mutates unmarked user files); the
  generated documentation states the obligation instead.
- The loader never writes any file, never mutates the environment of other
  processes, and never exports loaded values anywhere except
  `process.env` of the current process.
- Because the real environment always wins, a malicious or stale local file
  cannot displace platform-injected credentials in an environment that sets
  them.

## Limits and operational behavior

| Dimension | Rule |
| --- | --- |
| Environment files per process | Exactly 1 |
| File size | 65,536 bytes encoded |
| Applied keys | 256 |
| Value length | 4,096 Unicode scalar values |
| Loads per process | 1, synchronous, at startup |
| Third-party dependencies | 0; Node built-ins only |
| Files written by the loader | 0 |
| Network operations | 0 |

Missing-name diagnostics list names in the declared order. Key-validation
failures report the first offending key in file order. These orders MUST be
stable across runs with identical inputs.

## Versioning and compatibility

- The convention and the generated loader are governed by the same
  authorizing ADR as the HTTP engine build and deploy toolkit; no additional
  package or ADR is required.
- `AI_ENGINE_ENV_FILE` joins the toolkit's environment contract. Renaming
  it after release is breaking and requires a documented migration.
- The parsing dialect is whatever `util.parseEnv` implements at the pinned
  Node.js floor. Raising the repository floor MAY change accepted syntax;
  a floor raise MUST rerun the parsing fixtures and record any observable
  difference in release notes.
- Scaffolded `src/env.ts` files are user-owned; a later toolkit release
  changes only what new scaffolds emit. Authors upgrade an existing loader
  manually, like any other source file.
- Layered profile files, if ever added, must extend this contract with an
  explicit precedence specification; the single-file contract here MUST NOT
  be reinterpreted.

## Acceptance criteria

| ID | Observable outcome | Minimum evidence |
| --- | --- | --- |
| `AE-ENV-AC-01` | With no `.env` and no override, startup proceeds and `process.env` is untouched. | Composition-root fixture asserting deep environment equality. |
| `AE-ENV-AC-02` | A `.env` value fills an absent variable, and the same key already present in the environment — including present-but-empty — is never overridden. | Precedence matrix test. |
| `AE-ENV-AC-03` | `AI_ENGINE_ENV_FILE` selects an alternate file; when it names a missing or non-regular path, startup fails with the stable message and starts no adapter. | Override fixtures with listener spies. |
| `AE-ENV-AC-04` | Comment, quoting, and whitespace handling matches `util.parseEnv` for a fixture set exercised against the real platform parser, not a reimplementation. | Differential fixtures comparing loader output to direct `util.parseEnv` output. |
| `AE-ENV-AC-05` | A symlinked file, a NUL byte, 65,537 bytes, 257 applicable keys, and a 4,097-scalar value each abort startup before any key is applied; the inclusive bounds succeed. | Inclusive/exclusive boundary fixtures. |
| `AE-ENV-AC-06` | An applicable key failing the name pattern aborts startup naming that key; the same key pre-existing in the environment does not. | Key-validation tests. |
| `AE-ENV-AC-07` | A missing or empty declared required variable aborts startup listing exactly the missing names, and no value or partial value appears in any output. | Secret-sentinel leak test over stderr and thrown errors. |
| `AE-ENV-AC-08` | `init` generates `src/env.ts` and `.env.example`; the example lists exactly the manifest's declared names with empty values; rerunning `init` skips both. | Scaffold fixture with golden files. |
| `AE-ENV-AC-09` | The scaffolded HTTP root loads the file before reading its environment contract, so a `.env`-supplied `AI_ENGINE_HTTP_PORT` binds the port when the variable is otherwise absent. | End-to-end scaffold startup test. |
| `AE-ENV-AC-10` | A packaged container context contains no `.env*` file even when several exist in the project. | Build-context enumeration test over the generated `.dockerignore`. |
| `AE-ENV-AC-11` | The loader module imports only Node built-ins and performs no write, spawn, or network operation. | Import-graph check plus filesystem, child-process, and network sentinels. |

## Traceability

| Requirement | Contract surface | Acceptance evidence |
| --- | --- | --- |
| Deterministic local loading | Canonical path, override, single synchronous load | `AE-ENV-AC-01`, `AE-ENV-AC-03`, `AE-ENV-AC-09` |
| Real environment precedence | Non-overriding application | `AE-ENV-AC-02` |
| Platform-pinned parsing | `util.parseEnv` dialect | `AE-ENV-AC-04` |
| Fail-closed safety | File safety, key validation, bounds | `AE-ENV-AC-05`, `AE-ENV-AC-06` |
| Required-variable gate | Presence check, manifest derivation | `AE-ENV-AC-07`, `AE-ENV-AC-08` |
| Secret hygiene | Names-only diagnostics, no image or VCS leakage | `AE-ENV-AC-07`, `AE-ENV-AC-08`, `AE-ENV-AC-10` |
| Existing architecture unchanged | No runtime package change, built-ins only | `AE-ENV-AC-11`, package dependency review |

## Delivery slices

Implementation follows ADR 0008 and lands inside the deploy toolkit's
delivery plan. Each slice begins with failing executable evidence, ends
green, and is one cohesive commit:

1. Extend the deploy toolkit's authorizing ADR with this scaffold expansion
   and the `AI_ENGINE_ENV_FILE` contract addition.
2. Implement the loader contract as the scaffold template with differential
   parsing, precedence, boundary, and sentinel tests.
3. Implement the required-name check and its manifest-derived generation,
   with secret-sentinel leak tests.
4. Add `.env.example` generation to `init` and the marker-governed
   regeneration to `package`.
5. Update `DEPLOYMENT.md` generation and the getting-started guide with the
   convention for non-toolkit engines.

## Decisions required before implementation

1. **Convention plus scaffold versus published helper.** This draft ships
   the loader as generated, user-owned source with zero dependencies. The
   alternative — a small published runtime package (for example
   `@ai-engine/env`) — would centralize fixes but adds a sixth published
   package and a runtime dependency for something Node built-ins already
   cover. Confirm the generated-source approach.
2. **Strictness of key validation.** `AE-ENV-LOAD-06` fails closed on a
   non-conforming key. The lenient alternative (apply whatever
   `util.parseEnv` returns) tolerates more real-world files but lets typos
   pass silently. Confirm fail-closed.
3. **Profile layering demand.** `.env.local` and per-mode files are
   deferred. Confirm no current engine needs layering before first release.
4. **Production guard.** The draft relies on images not containing `.env`
   rather than on a `NODE_ENV` check inside the loader. Confirm that no
   explicit refuse-to-load-in-production behavior is wanted.

## Deferred and unspecified

The following require later evidence and an explicit specification update:

- multiple environment files, profiles, and layered precedence;
- variable expansion and interpolation dialects;
- encrypted environment files and secret-manager integration;
- a published runtime configuration package or typed configuration schema;
- schema-validated values, coercion, and defaults beyond presence checks;
- reloading environment values in a running process;
- toolkit-side linting of a real `.env` against the manifest;
- Windows-specific path and permission semantics for environment files.
