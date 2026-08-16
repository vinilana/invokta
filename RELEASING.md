# Releasing Invokta

Invokta publishes its ten public packages from one protected GitHub Actions
workflow. Stable versions publish directly to the `latest` dist-tag. The
versioned scripts under `scripts/release` contain the release rules; the
workflow supplies the trusted environment and orchestration.

## One-time repository setup

Create a protected GitHub environment named `npm` and configure:

- required reviewer approval before the publish job starts;
- deployment tag access restricted to `v*`; and
- no npm token secret.

For every package listed in `scripts/release/release-packages.json`, configure
an npm trusted publisher with these exact values:

- repository: `vinilana/invokta`;
- workflow filename: `security-and-release.yml`;
- environment: `npm`; and
- allowed action: `npm publish`.

Trusted publishing requires npm 11.5.1 or newer. The workflow installs npm 11
before publication and grants only `contents: read` and `id-token: write` to the
publish job. npm uses the short-lived GitHub OIDC identity and generates package
provenance without an npm token.

## Release flow

1. Prepare and merge the cohesive `chore/release-X.Y.Z` change through the
   documented release preparation workflow.
2. On a clean checkout whose `HEAD` matches `origin/main`, run:

   ```bash
   yarn release:create-tag X.Y.Z
   ```

3. Confirm the annotated tag. Its push starts `security-and-release.yml`.
4. Wait for the `Verify` job, then approve the protected `npm` environment.
5. Confirm that all packages publish and that the final job creates the GitHub
   Release.

The GitHub Release is created only after every package reports the release
version as `latest` with a matching `gitHead`.

## Read-only preflight

After checking out an existing release tag, run the complete read-only
publication preflight with:

```bash
yarn release:publish --check X.Y.Z
```

The command validates the annotated local and remote tag, the commit on
`origin/main`, all package names and versions, registry state, build, and package
dry-runs. It does not require npm authentication and makes no registry change.

## Recovering a partial release

npm package publication is irreversible and a ten-package release is not an
atomic registry operation. If a publish job stops after creating a partial
release, rerun the failed GitHub Actions workflow. The publication script skips
only a package version whose npm `gitHead` matches the release tag and whose
`latest` dist-tag already points to that version, then continues in dependency
order.

The preflight refuses to overwrite an existing version from another commit,
move `latest` backward, or recover a version that was previously published under
a different dist-tag. Do not publish or repair a stable release from a local
workstation; use the protected workflow so the OIDC identity and audit trail are
preserved.
