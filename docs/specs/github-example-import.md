# GitHub example import for create-invokta-engine

Status: Implemented by ADR 0020

Contract review verdict: **APPROVED**

## Summary

`create-invokta-engine` gains an optional `--example` mode that bootstraps a
project from a public GitHub repository or subdirectory, similar to
`create-next-app --example`. Official Invokta recipe examples under
`examples/<name>` are addressable by short name; any other public GitHub
repository is addressable by HTTPS URL.

The existing closed profile scaffolds remain the offline default. Example import
is mutually exclusive with `--profile`, reuses the creator's target safety,
confirmation, exclusive-write, rollback, and package-manager boundaries, and
never creates a second capability execution path.

## Problem

Invokta documents recipes that are backed by runnable examples, and the
community needs to start from those patterns or from external template
repositories. Today authors must clone the monorepo or copy trees by hand.
`create-next-app` already solved the analogous problem with `--example` and
`--example-path` against public GitHub tarballs.

The creator must gain that bootstrap path without becoming a remote registry,
template language, or authenticated Git client, and without weakening the
offline profile path guaranteed by ADR 0012 and ADR 0018.

## Goals

- Accept `--example <name|github-url>` and optional `--example-path <subdir>`.
- Resolve official short names to `vinilana/invokta` `examples/<name>` on `main`.
- Resolve public `https://github.com/...` repository and tree URLs.
- Verify that the resolved example root contains `package.json` before mutation.
- Download only from `codeload.github.com` after confirmation or `--yes`.
- Rewrite the generated `package.json` `name` to the project directory name.
- Preserve target safety, exclusive creation, rollback, install flags, and
  sanitized diagnostics.
- Keep profile scaffolding offline except for the existing package-manager
  install.
- Make every network and archive operation injectable for deterministic tests.

## Non-goals

- Private repositories, tokens, SSH, or `git clone`.
- Non-GitHub hosts, gists, or raw file URLs.
- A browsable remote catalog, plugin system, or template language.
- Variable substitution beyond the `package.json` `name` rewrite.
- Combining `--example` with `--profile`.
- Mutating or upgrading previously generated projects.
- Guaranteeing that every monorepo example is a complete standalone toolchain
  when copied; the example author owns dependency completeness.
- Prompting for the example source interactively.

## Command contract

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

Parsing rules:

- `--example` and `--profile` together are invalid usage.
- `--example-path` without `--example` is invalid usage.
- Duplicate `--example` or `--example-path`, missing values, empty values, and
  `--option=value` forms remain invalid usage.
- `--yes` still requires an explicit target.
- Interactive mode still prompts for a missing target and final confirmation.
  When `--example` is present it does not ask for a profile.
- Non-terminal mode with `--example` and an explicit target proceeds without
  prompts; a missing target remains `INTERACTIVE_REQUIRED`.

### Example reference forms

| Input | Resolution |
| --- | --- |
| `auth-clerk-engine` | `vinilana/invokta`, branch `main`, path `examples/auth-clerk-engine` |
| `https://github.com/acme/engine-template` | `acme/engine-template`, default branch from GitHub API, path from `--example-path` or empty |
| `https://github.com/acme/repo/tree/main/templates/engine` | `acme/repo`, branch `main`, path `templates/engine` |

Short names MUST match
`^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$`, contain at most 8
segments, and be at most 214 characters. GitHub URLs MUST use the `https:`
scheme and the `github.com` host. `http:`, SSH, credentials in the URL, and
other hosts are `EXAMPLE_INVALID`.

`--example-path` MUST be a relative POSIX path without empty segments, `.`, or
`..`, at most 1,024 Unicode scalars and 32 segments. When both a tree URL path
and `--example-path` are present, `--example-path` wins.

### Planning and mutation

1. Parse and validate the example reference locally.
2. Resolve repository metadata. Whole-repo URLs query
   `https://api.github.com/repos/<owner>/<repo>` for the default branch.
3. Verify `package.json` exists at the resolved path through a GitHub contents
   check before confirmation or write.
4. Interactive confirmation names the normalized target, example label, package
   manager, and installation choice. Planning and resolution perform no
   filesystem mutation of the target.
5. After confirmation, revalidate the empty target, download
   `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`, extract only the
   selected subtree into a temporary directory, rewrite `package.json` `name`,
   and copy regular files into the target with exclusive creation.
6. Archive symbolic links, hard links, absolute entry paths, and `..` segments
   are rejected. A failure rolls back only target entries created by that
   invocation and removes the temporary directory.
7. Unless `--no-install` is set, exactly one shell-free package-manager install
   runs after the copy completes.

`--no-install` skips dependency installation only. Example resolution and
download still require network access.

### Limits

| Limit | Value |
| --- | ---: |
| `--example` scalars | 2,048 |
| Short-name characters | 214 |
| Short-name segments | 8 |
| `--example-path` scalars | 1,024 |
| `--example-path` segments | 32 |
| Fetch timeout | 60 seconds |
| Uncompressed archive bytes retained | 52,428,800 (50 MiB) |
| Compressed download bytes | 52,428,800 (50 MiB) |
| Extracted regular files | 10,000 |
| Single extracted file bytes | 5,242,880 (5 MiB) |

### Diagnostics

| Code | Exit | Message |
| --- | ---: | --- |
| `EXAMPLE_INVALID` | `2` | `The example reference is invalid.` |
| `EXAMPLE_UNAVAILABLE` | `1` | `The example could not be resolved or downloaded.` |
| `EXAMPLE_FAILED` | `1` | `The example project could not be created.` |

Diagnostics MAY name a stable detail such as `package.json` or a
project-relative path after extraction starts. They MUST NOT echo the rejected
argument, response bodies, tokens, child errors, stacks, or causes.

### Success output

```text
Created <project-name> from example <label>.
```

followed by the existing next-step install or check guidance. The label is the
short name, or `<owner>/<repo>` optionally suffixed with `/<path>`.

## Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC-CREATE-EXAMPLE-01 | `--example` and `--profile` together exit `2` with invalid-usage text and perform no network or filesystem mutation. |
| AC-CREATE-EXAMPLE-02 | Official short names resolve to `vinilana/invokta` `examples/<name>` on `main` and require a remote `package.json`. |
| AC-CREATE-EXAMPLE-03 | Public GitHub repository and tree URLs resolve owner, repo, ref, and path; non-HTTPS or non-github.com references are `EXAMPLE_INVALID`. |
| AC-CREATE-EXAMPLE-04 | Interactive confirmation names the example label and writes nothing on cancellation. |
| AC-CREATE-EXAMPLE-05 | After confirmation, the creator downloads from `codeload.github.com`, copies only the selected subtree, and sets `package.json` `name` to the project directory name. |
| AC-CREATE-EXAMPLE-06 | Archive symlinks, path escape attempts, missing `package.json`, timeouts, and over-limit archives fail with sanitized `EXAMPLE_*` diagnostics and leave no retained target files when rollback succeeds. |
| AC-CREATE-EXAMPLE-07 | Profile scaffolding without `--example` still starts no creator-owned network request; `--no-install` with `--example` still downloads but starts no package manager. |
| AC-CREATE-EXAMPLE-08 | Focused unit tests inject fetch/download and cover happy path, invalid references, unavailable examples, and extract failures without live network access. |

## Traceability

| Requirement | Contract | Tests |
| --- | --- | --- |
| `AE-CREATE-EXAMPLE-01` | Mutual exclusion and usage parsing | `packages/create-invokta-engine/test/cli.test.ts` |
| `AE-CREATE-EXAMPLE-02..03` | Reference resolution | `packages/create-invokta-engine/test/example.test.ts` |
| `AE-CREATE-EXAMPLE-04..05` | Confirmation, download, rename | `packages/create-invokta-engine/test/cli.test.ts`, `test/example.test.ts` |
| `AE-CREATE-EXAMPLE-06` | Limits and safe extract | `packages/create-invokta-engine/test/example.test.ts` |
| `AE-CREATE-EXAMPLE-07` | Offline profile path | existing profile CLI tests plus example `--no-install` cases |
| `AE-CREATE-EXAMPLE-08` | Injected network boundary | all example tests use fakes |

## Conditions before release

1. Accept ADR 0020.
2. Update architecture, package README, docs site reference, ADR index, and
   validation record in the same deliverable.
3. Keep `tar` as a direct dependency of `create-invokta-engine` only.
