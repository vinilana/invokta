---
name: prepare-invokta-release
description: "Prepare Invokta versioned releases on dedicated release branches with synchronized package metadata, changelog and validation evidence, complete repository gates, and one cohesive commit. Use when asked to prepare, cut, stage, or validate an Invokta release or release candidate."
---

# Prepare an Invokta Release

## Establish the release branch

1. Read `.agents/skills/invokta-delivery/SKILL.md`, `docs/README.md`, the
   release gates in `docs/implementation-plan-and-acceptance-criteria.md`, and
   the ADRs represented by the unreleased changes.
2. Inspect the working tree, current branch, local and remote mainline refs,
   recent tags, `CHANGELOG.md`, and commits since the latest release. Preserve
   unrelated changes and stop if they make the release slice ambiguous.
3. Select the next semantic version from the compatibility of the Unreleased
   changes and the repository's prior release policy. Request a decision when
   the correct increment is ambiguous.
4. Confirm the intended mainline base. If local `main` and `origin/main`
   diverge, resolve the base explicitly before continuing.
5. Create or switch to `chore/release-X.Y.Z` from the confirmed mainline before
   editing any release file. Never prepare or commit a release on `main`.

## Synchronize release metadata

1. Bump the root version and every public package version to `X.Y.Z`.
2. Bump every exact internal `@invokta/*` dependency pin in public packages and
   examples. Update version assertions and protocol client self-identification
   constants that intentionally track the release.
3. Search the repository for the previous version. Classify every match as
   current release metadata, historical release documentation, or an unrelated
   dependency before changing it.
4. Synchronize committed example lockfiles. For unpublished Invokta packages,
   derive integrity values from the exact locally packed `X.Y.Z` artifacts;
   never retain old integrity hashes or invent new ones. Recheck the hashes if
   package contents change afterward.
5. Move the Unreleased notes under `## [X.Y.Z] - YYYY-MM-DD`, update the
   Unreleased comparison base, and add the release link. Preserve historical
   entries and write all release content in English.
6. Refresh `docs/validation-record.md` only with evidence produced during this
   release run, including the review date, accepted ADRs, test totals,
   coverage, and audit count.

Do not change a public contract merely to prepare the release. If preparation
reveals a missing or conflicting contract, stop and apply
`$invokta-contract-review` before continuing.

## Run the release gates

Run the canonical commands from a clean dependency state:

```sh
yarn install --frozen-lockfile --non-interactive
yarn run check
yarn audit
cd apps/docs
yarn install --frozen-lockfile --non-interactive
yarn validate
```

Return to the repository root and then:

1. Update the validation record with the exact results and stage only the
   cohesive release slice.
2. Inspect `git diff --cached`, run `git diff --cached --check`, and confirm all
   package versions and internal pins equal `X.Y.Z`.
3. Run `yarn release:verify`. This verifier archives the Git index, so release
   files must be staged first; unstaged changes are intentionally excluded.
4. If a packed consumer tries to resolve `@invokta/*@X.Y.Z` from the registry,
   treat that as a pre-publish verifier defect. Record the failing command as
   RED, install the complete matching local tarball dependency closure in the
   fixture, and rerun the verifier for GREEN.
5. Rerun `yarn run check` after any executable verifier change. Reinspect the
   staged diff and confirm the working tree has no unstaged release changes.

Do not claim readiness while any typecheck, lint, formatting, test, coverage,
build, audit, documentation, package, or diff gate fails.

## Commit and hand off

1. Create one commit named `chore(release): prepare X.Y.Z` on the release
   branch.
2. Confirm `main` still points to the confirmed mainline, the release branch
   contains the commit, and the working tree is clean.
3. Report the version, branch, commit hash, RED/GREEN evidence or metadata-only
   exception, validation results, risks, and pending work.
4. Do not tag, push, publish packages, or create a pull request unless the user
   explicitly requests that separate action.
