# Contributing to Invokta

Invokta accepts focused changes that preserve its public contracts and keep
direct, CLI, and MCP execution on the single `engine.invoke` path. This guide
covers the repository workflow; generated Action Engines carry their own
`AGENTS.md`, README, and development skill.

## Prerequisites

- Git;
- Node.js 22.20.0, matching `.node-version`; and
- Yarn 1.22.22, provided through Corepack.

Clone and validate the repository:

```sh
git clone https://github.com/vinilana/invokta.git
cd invokta
corepack enable
yarn install --frozen-lockfile --non-interactive
yarn run check
```

`yarn run check` is the canonical local repository gate. It runs type checks,
lint, formatting checks, coverage tests, the build, and generated-example
checks.

## Prepare a focused branch

Start from an up-to-date, clean `main` branch and create one branch for the
deliverable:

```sh
git switch main
git pull --ff-only
git switch -c docs/short-description
```

Use a descriptive prefix such as `docs/`, `fix/`, `feat/`, or `refactor/`.
These names are guidance, not a contract. Do not mix unrelated cleanup into the
branch.

Before editing, read [AGENTS.md](./AGENTS.md). For a public API, schema, port,
event, error, configuration field, operational limit, or adapter-visible
behavior, also follow the normative reading order in
[docs/README.md](./docs/README.md) and identify the applicable ADRs. A breaking
contract change requires an explicit decision before implementation.

## Repository map

| Path | Responsibility |
| --- | --- |
| `packages/core` | Capability, connector, engine, validation, and invocation contracts |
| `packages/cli` | CLI adapter over `engine.invoke` |
| `packages/mcp` | MCP stdio and stateless HTTP adapters over `engine.invoke` |
| `packages/create-*` | Deterministic standalone project creators |
| `packages/tooling`, `packages/installer`, `packages/deploy`, `packages/devtools` | Development and delivery applications |
| `examples/` | Runnable contract and integration examples |
| `test/` | Repository-level type and architecture contracts |
| `docs/` | Normative contracts, ADRs, guides, and validation records |
| `apps/docs/` | Public documentation site with its own dependencies and lockfile |
| `.agents/skills/` | Repository delivery and contract-review workflows for compatible agents |

## Deliver one vertical slice

1. Define the observable acceptance criterion, affected contract, files, and
   validation command.
2. For executable behavior, add the smallest test and run it to confirm RED for
   the expected reason.
3. Implement only enough to reach GREEN, then refactor while keeping the focused
   test green.
4. Update the relevant documentation in the same slice.
5. Run focused validation, then the full applicable gates.
6. Inspect the final and staged diffs for unrelated files, generated artifacts,
   and secrets.
7. Create one cohesive English commit for the deliverable.

Documentation-only changes may omit RED because they add no executable
behavior. Record that exception and still validate formatting, links, generated
content, and any documentation application affected by the change.

## Validation commands

Use the shortest feedback loop while developing:

```sh
# One test file during RED/GREEN/REFACTOR
yarn vitest run path/to/file.test.ts

# All tests once, without watch mode
yarn test:run

# Individual repository gates
yarn typecheck
yarn lint
yarn format:check
yarn build
yarn check:examples

# Full local gate before handoff
yarn run check
```

`yarn test` starts Vitest's interactive mode; prefer `yarn test:run` in bounded
automation.

The public documentation application is not a root workspace. If a change
touches `apps/docs/`, install and validate it separately:

```sh
cd apps/docs
corepack enable
yarn install --frozen-lockfile --non-interactive
yarn validate
```

Pull-request CI also runs a Windows-specific creator test, dependency audit,
release-package dry run, and package-content verification. Those are additional
CI and release gates, not substitutes for the focused and full local checks.

## Work with a team of agents

Use a lead-and-reviewers pattern that remains portable across agent harnesses:

1. The lead confirms Git state, creates the branch, defines the acceptance
   criterion, integrates the result, validates it, and owns the final commit.
2. Every agent reads `AGENTS.md`, this guide, and the affected contracts and
   tests before acting.
3. Delegate bounded independent work. Parallel read-only audits are safest;
   write tasks must have non-overlapping file ownership.
4. Assume agents share a worktree. Never revert, overwrite, or broadly reformat
   another agent's changes.
5. Each agent reports evidence, paths changed, commands run, failures, and
   unresolved risks to the lead.
6. The lead reconciles every recommendation against the public contract and
   runs the canonical validation gates once the integrated diff is complete.

Invokta is not an agent harness. This collaboration pattern organizes repository
work; it does not add agent orchestration to the framework runtime.

## Commit and pull-request evidence

Use an imperative commit message that describes the delivered outcome, for
example `docs: clarify contributor onboarding`. The pull request should state:

- the acceptance criterion and affected public surface;
- test-first RED/GREEN evidence, or the documentation-only exception;
- focused and full commands with their results;
- applicable ADRs and contract decisions; and
- known risks, skipped gates, or follow-up work.

Review [the release guide](./RELEASING.md) only when preparing a versioned
release. Ordinary contributions must not change release metadata speculatively.
