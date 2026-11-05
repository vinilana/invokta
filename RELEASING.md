# Releasing Invokta

Invokta publishes its thirteen public packages from one protected GitHub Actions
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

A package name that has never been published must first be bootstrapped as
described in [First publication of a new package](#first-publication-of-a-new-package).

Trusted publishing requires npm 11.5.1 or newer. The workflow installs npm
11.19.0 before publication and grants only `contents: read` and `id-token:
write` to the publish job. npm uses the short-lived GitHub OIDC identity and
generates package provenance without an npm token.

The workflow pins the trusted-publishing npm version, forces every registry
operation to `https://registry.npmjs.org/`, and invokes the publication script
directly so package-manager environment overrides cannot redirect publication.
For tag runs, the Verify job executes the same script in read-only `--check`
mode before the protected publish job can start.

## First publication of a new package

npm configures a trusted publisher only for a package that already exists on
the registry. The npm CLI documentation for `npm trust` states that "the
package you're configuring must already exist on the npm registry", and the
trusted publishing guide starts from the package's settings page on
npmjs.com. A package name added to `scripts/release/release-packages.json`
therefore needs a one-time bootstrap before the first release tag that
includes it.

The preflight refuses a name that was never published: `--check` stops with
`<package> has no readable latest dist-tag`, so the tag's Verify job fails and
the protected publish job never starts. After the release preparation merges,
complete these steps for each new package before creating the tag:

1. Confirm the name has never been published:
   `npm view <package> --registry=https://registry.npmjs.org/` must report
   `E404`.
2. Sign in with an npm account that has account-level two-factor
   authentication and publish rights for the scope. In a new empty directory
   outside the repository, create a `package.json` containing only `name`,
   `version: "0.0.0"`, a `description` that marks it as a trusted publishing
   placeholder, `license: "MIT"`, and the repository URL, plus a README with
   the same statement. Run
   `npm publish --access public --registry=https://registry.npmjs.org/` there.
   This placeholder is the only publication made outside the workflow. It is
   not a release, has no code or `gitHead`, and must not reuse a real release
   version. Version `0.0.0` is the stable version that the preflight accepts
   as an older `latest`.
3. On the package's npmjs.com settings page, configure the trusted publisher
   with the values in [One-time repository setup](#one-time-repository-setup).
   npm does not verify the configuration when it is saved, so compare the
   repository, workflow filename, and environment exactly. npm 11.15.0 or newer
   can configure the same relationship with `npm trust`.
4. Under the package's publishing access, select **Require two-factor
   authentication and disallow tokens**, matching the token-free workflow.
5. Confirm `npm view <package> dist-tags.latest` prints `0.0.0`.
6. Create and push the release tag promptly. npm documents that a newly
   created trusted publisher configuration expires if its first successful
   publish does not happen within 2 days. An expired configuration must be
   deleted and created again.

The release workflow then publishes the new package in manifest order, moves
its `latest` dist-tag from `0.0.0` to the release, and verifies its `gitHead`
like every other package. A missing or mismatched trusted publisher makes npm
reject that package after the packages before it in the manifest were
published; correct the configuration and rerun the failed workflow as
described in [Recovering a partial release](#recovering-a-partial-release).
After the release, deprecate the placeholder with
`npm deprecate <package>@0.0.0 "Placeholder for trusted publishing setup; install a released version."`.

## Release flow

1. Prepare and merge the cohesive `chore/release-X.Y.Z` change through the
   documented release preparation workflow. If the release adds a package,
   complete [First publication of a new package](#first-publication-of-a-new-package)
   for it before the next step.
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

npm can accept a package and report that it is still being processed for
several minutes. After each publication, the script waits up to 10 minutes for
the version and `gitHead` to become readable, backing off from 5 to 30 seconds
between checks. The publish job allows 150 minutes: a full 10-minute wait for
each of the thirteen packages plus 20 minutes for checkout, installation,
build, and package checks. If a wait still expires, or the job reaches its
timeout, wait until the version and `gitHead` are readable before rerunning the
workflow: a version npm is still processing reads as missing, and publishing it
again fails.

npm package publication is irreversible and a multi-package release is not an
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

## Example lockfile integrity

Derive pre-release integrity values from artifacts built in a clean throwaway
checkout. A workspace installation can mark generated command files executable,
changing tarball hashes even when their contents match the CI build. Compare
file modes as well as contents when investigating an integrity mismatch.

After publication, verify every locked Invokta dependency against the registry's
`dist.integrity` and run `npm ci --ignore-scripts --no-audit --no-fund` in an
isolated copy of the example's manifest and lockfile. This also detects declared
dependencies missing from the lockfile.
