# ADR 0020: GitHub example import for the engine creator

- Status: Accepted
- Date: 2026-08-06

## Context

ADR 0012 and ADR 0018 define `create-invokta-engine` as a binary that emits one
of four offline starter profiles. Package-manager installation is the only
network activity on that path. Authors who want a recipe-backed or
community-owned starting point must clone repositories and copy trees by hand.

`create-next-app` already offers `--example` / `--example-path` against public
GitHub tarballs. Invokta needs the same bootstrap for official `examples/*`
recipes and for external public template repositories, without adding a remote
catalog, template language, authenticated Git client, or second capability
execution path.

## Decision

This decision extends ADR 0012 and ADR 0018 only by authorizing an explicit
`--example` creation mode. The closed profile scaffolds, target safety,
exclusive writes, rollback, package-manager install, interactive confirmation,
sanitized diagnostics, and binary-only package boundary remain in force for
profile creation. Profile creation without `--example` still performs no
creator-owned network request.

The command surface becomes:

```text
create-invokta-engine [project-directory]
  [--profile complete|mcp-stdio|mcp-http|cli]
  [--example <name|github-url>]
  [--example-path <subdir>]
  [--package-manager npm|pnpm|yarn]
  [--no-install]
  [--yes]
create-invokta-engine --help
create-invokta-engine --version
```

`--example` and `--profile` are mutually exclusive. `--example-path` requires
`--example`. Short names resolve to the official repository `vinilana/invokta`
on branch `main` under `examples/<name>`. HTTPS `github.com` repository and
tree URLs resolve owner, repository, ref, and optional subdirectory.
Non-HTTPS, non-`github.com`, credentialed, and SSH references are rejected.

Before confirmation or write, the creator resolves metadata and verifies that
`package.json` exists at the example root. After confirmation it downloads the
repository tarball from `codeload.github.com`, extracts only the selected
subtree into a temporary directory, requires the staged `package.json` to be a
regular file, rewrites its `name` to the project directory name, and copies
regular files into the empty target with exclusive creation and the existing
rollback rule. Within the selected subtree, archive symbolic links, hard links,
and non-directory entry types other than regular files (`File`, `OldFile`,
`ContiguousFile`) are rejected. Entries outside the selected subtree are never
extracted and do not invalidate an otherwise safe template merely because of
their type. Absolute paths, Windows drive/UNC paths, backslash-separated paths,
and parent-directory segments are rejected across the whole archive. Extracted
directory and regular-file counts are bounded.

Allowed creator-owned network hosts for example mode are `api.github.com` and
`codeload.github.com` only. The creator sends no authentication headers and
does not read GitHub tokens from the environment. Private repositories are out
of scope. Fetch operations use a 60-second timeout and enforce bounded archive
size, file count, and per-file size. Network and archive operations are
injected at the CLI boundary so acceptance tests need no live network.

`--no-install` continues to mean “start no package manager.” Example resolution
and download still require network access when `--example` is present.

The new sanitized diagnostics are:

| Code | Exit | Message |
| --- | ---: | --- |
| `EXAMPLE_INVALID` | `2` | `The example reference is invalid.` |
| `EXAMPLE_UNAVAILABLE` | `1` | `The example could not be resolved or downloaded.` |
| `EXAMPLE_FAILED` | `1` | `The example project could not be created.` |

Exact parsing, limits, and acceptance criteria are defined by the
[GitHub example import specification](../specs/github-example-import.md) and
the package acceptance tests.

## Consequences

- Authors can bootstrap from official recipe examples or any public GitHub
  template repository with one command.
- The offline profile path remains available and unchanged in its network
  boundary.
- Example completeness, including TypeScript and test tooling, is owned by the
  template author; the creator rewrites only the package name.
- Release verification must cover injected resolution, download, extract,
  rename, rollback, and mutual exclusion with `--profile`.
- A remote catalog, private-repo support, or non-GitHub hosts would require
  another architectural decision.
