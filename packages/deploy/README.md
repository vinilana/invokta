# @invokta/deploy

Development-time toolkit that turns an engine exposing MCP Streamable HTTP into
a reviewable container build context, and verifies a running endpoint. This
package contributes no runtime contract, capability, adapter, or transport. It
depends on Node built-ins only — not on `@invokta/core`, `@invokta/cli`,
`@invokta/mcp`, `@invokta/tooling`, or `@invokta/installer` — and no
runtime package depends on it. Generated user code imports `@invokta/mcp`; the
toolkit itself never does.

The toolkit generates and validates text. No command spawns a process, executes
a shell, or runs a package manager, compiler, or container tool. `init` and
`package` perform no network operation at all, and `probe` performs exactly one
HTTP request per invocation.

```text
invokta-deploy init
invokta-deploy package
invokta-deploy probe --url <url> [--expect alive|ready] [--bearer-env NAME]
                       [--host-header HOST] [--timeout-ms N]
invokta-deploy --help
invokta-deploy --version
```

All commands are non-interactive and require no TTY. Diagnostics and per-file
progress go to `stderr`; nothing is written to `stdout` except `--help` and
`--version` output.

## Exit codes

| Code | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| `0`  | The command succeeded; for `probe`, the endpoint is healthy.                                         |
| `1`  | The command completed but reported failures: a generated-file conflict, an invalid project input, or an unhealthy probe result. |
| `2`  | Invalid usage, a missing or invalid manifest, or an initialization failure.                          |

Orchestrating functions return these values and never call `process.exit`; only
the binary owns the final process status.

## invokta-deploy init

Scaffolds the deployment manifest, a production-shaped HTTP composition root,
its fail-closed authentication hook, the environment-file loader, and a
secret-free example file:

| File                    | Content                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `invokta.deploy.json` | The deployment manifest, with every documented default spelled out. |
| `src/mcp-http.ts`       | The composition root that reads the environment contract below.     |
| `src/http-auth.ts`      | The `auth.mode: "required"` hook, failing closed until implemented. |
| `src/env.ts`            | The environment-file loader and required-name check.                |
| `.env.example`          | One empty line per declared manifest name; safe to commit.          |

`init` never overwrites. An existing target is reported as `skipped` and the
command still exits `0`, so scaffolded source is yours from the first write and
the toolkit performs no drift tracking over `src/`. When the project already has
a manifest, the example file and the required-name check are derived from it, so
the manifest, `.env.example`, and the startup check cannot disagree.

The scaffold assumes the conventional `engine` export in `src/engine.ts`. Adjust
that import when your layout differs.

`src/http-auth.ts` throws at module load until you implement `authenticate`, so
a scaffolded engine can never serve an unverified request. The adapter's
`dangerously-disabled-for-development` mode is deliberately absent from every
template; it remains a manual, local-only choice.

## invokta-deploy package

Generates the deployment package. It validates in a fixed order — manifest,
`package.json` (`name`, `version`, and a `build` script), exactly one supported
lockfile, then the built entry file — and writes nothing until every check has
passed.

| File                    | Content                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `Dockerfile`            | Multi-stage build: install from the lockfile, run the build script, prune to production dependencies, then run as the non-root `node` user. |
| `.dockerignore`         | Excludes `.git`, `node_modules`, `test`, `coverage`, and every `.env*` file. |
| `deploy/healthcheck.mjs`| Self-contained health check using Node built-ins only.          |
| `deploy/DEPLOYMENT.md`  | Operator documentation generated from the manifest.            |

The lockfile determines the commands that appear as text in the `Dockerfile`;
the toolkit never runs them.

| Lockfile            | Install                          | Prune                                  |
| ------------------- | -------------------------------- | -------------------------------------- |
| `package-lock.json` | `npm ci`                         | `npm ci --omit=dev`                    |
| `pnpm-lock.yaml`    | `pnpm install --frozen-lockfile` | `pnpm install --prod --frozen-lockfile`|
| `yarn.lock`         | `yarn install --frozen-lockfile` | `yarn install --production --frozen-lockfile` |

No lockfile is `LOCKFILE_MISSING`; more than one is `LOCKFILE_AMBIGUOUS`. The
toolkit never guesses.

Every generated file begins with a fixed marker comment naming the toolkit and
its major version. `package` overwrites a file only when it is absent or carries
that marker on its first line; an unmarked file is a `GENERATED_FILE_CONFLICT`
for that file alone, the other three are still generated, and the command exits
`1`. Each file is reported as `created`, `updated`, `unchanged`, or `conflict`,
in lexicographic path order.

Output is deterministic and idempotent: given the same manifest, `package.json`,
lockfile, and toolkit version, the generated bytes are identical, and a
byte-identical regeneration is reported as `unchanged` without a write. Nothing
generated contains a timestamp, hostname, username, absolute local path, or
random value. Writes are atomic — a private temporary file, then a rename — in
UTF-8 with LF endings and a trailing newline.

Generated files are meant to be committed and reviewed like any other code.

## invokta-deploy probe

Performs one bounded MCP liveness or readiness check, for CI smoke tests and
container health checks. A healthy endpoint produces no output at all.

- `--url` must be an absolute HTTP(S) URL without userinfo, query, or fragment,
  whose path is exactly `/mcp`. HTTPS is required unless the host is exactly
  `127.0.0.1` or `[::1]`.
- `--expect` selects the classification below. It defaults to `alive`.
- `--bearer-env NAME` reads a bearer token from that environment variable. It is
  permitted only with `--expect ready`.
- `--host-header HOST` overrides the `Host` header, for probing a loopback
  listener whose allowlist names only public hosts.
- `--timeout-ms N` bounds the whole exchange. It defaults to `3000`, with bounds
  `1..60000`.

The probe sends one MCP `initialize` request over HTTP POST with the protocol
version pinned by ADR 0006, and performs no retry, no redirect following, and no
connection reuse.

| Expectation | Healthy when                                                                                | Unhealthy                                                             |
| ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `alive`     | HTTP 401 carrying a `Bearer` challenge, **or** a valid HTTP 200 `initialize` result.          | Connection failure, timeout, 403, 404, 5xx, or a malformed response.   |
| `ready`     | A valid HTTP 200 `initialize` result, using the `--bearer-env` token when given.              | Everything else, including 401.                                       |

`alive` accepts the authentication challenge deliberately: it proves the
adapter's boundary is serving without requiring the probe to hold a credential.
A 403 is never healthy, because a Host or Origin rejection would reject real
clients too.

A credential enters only through an environment variable name. The token value
never appears in argv, output, diagnostics, or error causes.

The generated `deploy/healthcheck.mjs` implements this same contract against
`http://127.0.0.1:<port>/mcp` using the manifest's `healthcheck` settings. Both
surfaces read the pinned protocol revision and the default deadline from one
module, so they cannot disagree. Because the adapter validates the raw `Host`
header, the script sends the first entry of `INVOKTA_HTTP_ALLOWED_HOSTS` as
its `Host` when that variable is set, so the runtime allowlist never has to
admit a loopback host.

## Deployment manifest

`invokta.deploy.json` at the engine project root is the single input that
parameterizes scaffolding, packaging, and health checks.

```json
{
  "schemaVersion": 1,
  "entry": "dist/mcp-http.js",
  "env": {
    "required": ["SUPPORT_API_TOKEN"],
    "optional": ["INVOKTA_HTTP_ALLOWED_ORIGINS"]
  },
  "image": {
    "baseImage": "node:22-slim",
    "port": 3000
  },
  "healthcheck": {
    "expect": "alive"
  }
}
```

| Key                       | Rule                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `schemaVersion`           | Required; exactly the number `1`. Any other value fails before a file is read or written. |
| `entry`                   | Required; a relative, NUL-free path with no `..` segment, ending in `.js` or `.mjs`. It is the built ESM module the container starts. |
| `env.required`, `env.optional` | Names only, each matching `^[A-Z_][A-Z0-9_]{0,127}$`, unique across both lists, at most 64 in total. Never values. |
| `image.baseImage`         | Defaults to `node:22-slim`; non-empty, no whitespace or NUL. The image is validated textually and never pulled. |
| `image.port`              | Defaults to `3000`; an integer in `1..65535`.                                             |
| `healthcheck.expect`      | Defaults to `alive`.                                                                      |
| `healthcheck.bearerEnv`   | An environment variable name; permitted only when `expect` is `ready`.                    |

The schema is closed: every object rejects unknown keys. The document is bounded
to 65,536 encoded bytes and each string to 1,024 Unicode scalar values.
Validation reports every detectable issue at once, in JSON-pointer order, and
never echoes a rejected value.

## Environment contract

The generated composition root implements this contract. It is a convention of
generated application code, not a runtime-package feature.

| Variable                         | Meaning                                                     | Default              |
| -------------------------------- | ----------------------------------------------------------- | -------------------- |
| `INVOKTA_HTTP_HOST`            | Bind host passed to `serveMcpHttp`; the image sets `0.0.0.0`.| `127.0.0.1`          |
| `INVOKTA_HTTP_PORT`, `PORT`    | Bind port; the Invokta-specific name wins when both are set.     | `3000`               |
| `INVOKTA_HTTP_ALLOWED_HOSTS`   | Comma-separated `Host` allowlist, required for a non-loopback bind. | unset         |
| `INVOKTA_HTTP_ALLOWED_ORIGINS` | Comma-separated browser origin allowlist.                    | unset                |
| `INVOKTA_HTTP_MAX_BODY_BYTES`  | Request body limit override.                                 | adapter default (1 MiB) |
| `INVOKTA_ENV_FILE`             | Path of the environment file to load instead of `.env`.      | `.env`               |

List values are split on commas, trimmed, and emptied of blank items. A
non-integer value, an out-of-range value, or a NUL aborts startup rather than
falling back to a default, and the scaffold refuses a non-loopback bind without
an explicit `Host` allowlist. The composition root writes its endpoint
announcement and its errors to `stderr` only, never a header or environment
value, and closes the server on `SIGTERM` and `SIGINT` before exiting `0`.

## Environment files

`init` generates `src/env.ts`, which applies one environment file to
`process.env` when it is imported — first, once, before any other module reads
configuration.

- The default file is `.env` in the process working directory. A missing
  default is a silent no-op; a file named by `INVOKTA_ENV_FILE` that is
  missing or not a regular file is a startup failure, because an explicit
  request must not degrade silently.
- The real environment always wins. The loader only adds absent keys, so a
  variable already present — including present but empty — is never replaced.
  Precedence is process environment, then environment file, then defaults.
- Parsing is Node's built-in `util.parseEnv`. No `dotenv` and no dialect of the
  toolkit's own.
- The file must be a regular, non-symlink file of at most 65,536 bytes with no
  NUL byte, applying at most 256 keys whose values are at most 4,096 Unicode
  scalar values each. Every applied key must match the environment name
  pattern; a typo aborts startup naming that key rather than passing silently.
- After loading, the manifest's `env.required` names must be present and
  non-empty. A failure lists the missing names — names only — on `stderr` and
  starts nothing.

Environment files are a development convenience, never a deployment mechanism.
Commit `.env.example`, never `.env`, and inject production values through the
platform. The generated `.dockerignore` excludes every `.env*` file, so no image
built from the generated context contains one.

## Programmatic API

```ts
import { runDeployCli } from "@invokta/deploy";

const exitCode = await runDeployCli({
  argv: ["probe", "--url", "https://engine.example/mcp"],
  cwd: process.cwd(),
});
```

`runDeployCli` resolves with the exit code and writes diagnostics through the
injectable `io.writeStderr` sink. It never terminates the process. `runInit`,
`runPackage`, and `runProbe` are exported for the same purpose, each taking its
argument list and a `DeployContext`.
