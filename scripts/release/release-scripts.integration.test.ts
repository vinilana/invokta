import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots: string[] = [];
const releaseVersion = "1.2.3";
const releaseTag = `v${releaseVersion}`;
const releaseCommit = "1111111111111111111111111111111111111111";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function copyReleaseScript(repository: string, name: string): void {
  copyFileSync(
    join(repositoryRoot, "scripts", "release", name),
    join(repository, "scripts", "release", name),
  );
}

type PublishFixtureOptions = {
  gitHead?: string;
  latest: string;
  oidc?: boolean;
  targetState: "pending" | "present";
};

function runPublishFixture(options: PublishFixtureOptions) {
  const root = temporaryDirectory("invokta-publish-script-");
  const binDirectory = join(root, "bin");
  const releaseDirectory = join(root, "scripts", "release");
  const packageDirectory = join(root, "packages", "fixture");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(packageDirectory, { recursive: true });

  for (const script of [
    "check-packages.sh",
    "package-set.sh",
    "publish-release.sh",
    "release-packages.json",
    "release-packages.mjs",
  ]) {
    copyReleaseScript(root, script);
  }

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: releaseVersion })}\n`,
  );
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@invokta/fixture", version: releaseVersion })}\n`,
  );
  writeFileSync(
    join(releaseDirectory, "release-packages.json"),
    `${JSON.stringify([
      {
        directory: "fixture",
        name: "@invokta/fixture",
        requiredFiles: ["dist/index.js"],
      },
    ])}\n`,
  );

  writeExecutable(
    join(binDirectory, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" ]]; then
  printf '%s\n' "$STUB_REPOSITORY_ROOT"
  exit 0
fi
case "\${1:-}" in
  fetch)
    ;;
  status)
    printf '%s' "\${STUB_GIT_STATUS:-}"
    ;;
  cat-file)
    printf 'tag\n'
    ;;
  rev-list)
    printf '%s\n' "$STUB_COMMIT"
    ;;
  rev-parse)
    printf '%s\n' "$STUB_COMMIT"
    ;;
  merge-base)
    ;;
  ls-remote)
    if [[ "$4" == *'^{}' ]]; then
      printf '%s\\t%s\n' "$STUB_COMMIT" "$4"
    else
      printf '%s\\t%s\n' "$STUB_TAG_OBJECT" "$4"
    fi
    ;;
  *)
    printf 'Unexpected git invocation: %s\n' "$*" >&2
    exit 70
    ;;
esac
`,
  );
  writeExecutable(
    join(binDirectory, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  --version)
    printf '11.5.1\n'
    ;;
  config)
    printf 'https://registry.npmjs.org/\n'
    ;;
  ping|pack)
    ;;
  publish)
    printf '%s\n' "$*" >> "$STUB_PUBLISH_LOG"
    : > "$STUB_PUBLISHED_MARKER"
    ;;
  view)
    package_spec="$2"
    field="$3"
    if [[ "$package_spec" == "$STUB_PACKAGE_NAME" && "$field" == "dist-tags.latest" ]]; then
      if [[ -f "$STUB_PUBLISHED_MARKER" ]]; then
        printf '%s\n' "$STUB_VERSION"
      else
        printf '%s\n' "$STUB_LATEST"
      fi
    elif [[ "$package_spec" == "$STUB_PACKAGE_NAME@$STUB_VERSION" ]]; then
      if [[ "$STUB_TARGET_STATE" == "pending" && ! -f "$STUB_PUBLISHED_MARKER" ]]; then
        printf 'npm error code E404\n' >&2
        exit 1
      fi
      if [[ "$field" == "version" ]]; then
        printf '%s\n' "$STUB_VERSION"
      elif [[ -f "$STUB_PUBLISHED_MARKER" ]]; then
        printf '%s\n' "$STUB_COMMIT"
      else
        printf '%s\n' "$STUB_GIT_HEAD"
      fi
    else
      printf 'Unexpected npm view: %s %s\n' "$package_spec" "$field" >&2
      exit 71
    fi
    ;;
  *)
    printf 'Unexpected npm invocation: %s\n' "$*" >&2
    exit 72
    ;;
esac
`,
  );
  writeExecutable(
    join(binDirectory, "yarn"),
    "#!/usr/bin/env bash\nset -euo pipefail\n",
  );

  const publishLog = join(root, "publish.log");
  const publishedMarker = join(root, "published");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    STUB_COMMIT: releaseCommit,
    STUB_GIT_HEAD: options.gitHead ?? releaseCommit,
    STUB_LATEST: options.latest,
    STUB_PACKAGE_NAME: "@invokta/fixture",
    STUB_PUBLISHED_MARKER: publishedMarker,
    STUB_PUBLISH_LOG: publishLog,
    STUB_REPOSITORY_ROOT: root,
    STUB_TAG_OBJECT: "2222222222222222222222222222222222222222",
    STUB_TARGET_STATE: options.targetState,
    STUB_VERSION: releaseVersion,
  };
  if (options.oidc !== false) {
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "test-token";
    environment.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.invalid/token";
  } else {
    delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  }

  const result = spawnSync(
    "bash",
    [join(releaseDirectory, "publish-release.sh"), releaseVersion],
    { cwd: root, encoding: "utf8", env: environment },
  );

  return {
    publishLog: existsSync(publishLog) ? readFileSync(publishLog, "utf8") : "",
    result,
  };
}

function createTagFixture() {
  const root = temporaryDirectory("invokta-create-tag-");
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["config", "user.name", "Release Test"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "release@example.invalid"], {
    cwd: repository,
  });
  mkdirSync(join(repository, "scripts", "release"), { recursive: true });
  copyReleaseScript(repository, "create-tag.sh");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify({ version: releaseVersion })}\n`,
  );
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-m", "release fixture"], {
    cwd: repository,
  });
  execFileSync("git", ["remote", "add", "origin", remote], {
    cwd: repository,
  });
  execFileSync("git", ["push", "-u", "origin", "main"], {
    cwd: repository,
  });

  return {
    remote,
    repository,
    run: (input?: string) =>
      spawnSync(
        "bash",
        [
          join(repository, "scripts", "release", "create-tag.sh"),
          releaseVersion,
        ],
        { cwd: repository, encoding: "utf8", input },
      ),
  };
}

describe("publish-release.sh", () => {
  it("publishes a pending package directly to latest", () => {
    const { publishLog, result } = runPublishFixture({
      latest: "1.2.2",
      targetState: "pending",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Pending: @invokta/fixture@1.2.3");
    expect(publishLog).toContain(
      "publish ./packages/fixture --access public --tag latest",
    );
  });

  it("skips an already published package from the release commit", () => {
    const { publishLog, result } = runPublishFixture({
      latest: releaseVersion,
      targetState: "present",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Present: @invokta/fixture@1.2.3 (matching gitHead)",
    );
    expect(publishLog).toBe("");
  });

  it("refuses an existing package version from another commit", () => {
    const { publishLog, result } = runPublishFixture({
      gitHead: "3333333333333333333333333333333333333333",
      latest: releaseVersion,
      targetState: "present",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists with gitHead");
    expect(publishLog).toBe("");
  });

  it("refuses to move latest backward", () => {
    const { publishLog, result } = runPublishFixture({
      latest: "2.0.0",
      targetState: "pending",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("newer than 1.2.3");
    expect(publishLog).toBe("");
  });

  it("refuses publication when GitHub Actions OIDC is missing", () => {
    const { publishLog, result } = runPublishFixture({
      latest: "1.2.2",
      oidc: false,
      targetState: "pending",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub Actions OIDC is unavailable");
    expect(publishLog).toBe("");
  });
});

describe("create-tag.sh", () => {
  it("refuses a dirty checkout", () => {
    const fixture = createTagFixture();
    writeFileSync(join(fixture.repository, "untracked.txt"), "dirty\n");

    const result = fixture.run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree must be clean");
  });

  it("refuses a commit other than origin/main", () => {
    const fixture = createTagFixture();
    writeFileSync(join(fixture.repository, "change.txt"), "change\n");
    execFileSync("git", ["add", "change.txt"], { cwd: fixture.repository });
    execFileSync("git", ["commit", "-m", "diverge from main"], {
      cwd: fixture.repository,
    });

    const result = fixture.run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HEAD must match origin/main");
  });

  it("accepts an existing matching annotated local and remote tag", () => {
    const fixture = createTagFixture();
    execFileSync("git", ["tag", "-a", releaseTag, "-m", "release fixture"], {
      cwd: fixture.repository,
    });
    execFileSync("git", ["push", "origin", releaseTag], {
      cwd: fixture.repository,
    });

    const result = fixture.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${releaseTag} already exists on origin`);
  });

  it("does not create or push a tag after rejected confirmation", () => {
    const fixture = createTagFixture();

    const result = fixture.run("cancel\n");
    const remoteTags = execFileSync(
      "git",
      ["ls-remote", "--tags", fixture.remote, `refs/tags/${releaseTag}`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Tag creation cancelled");
    expect(remoteTags).toBe("");
    expect(() =>
      execFileSync("git", ["rev-parse", "--verify", releaseTag], {
        cwd: fixture.repository,
        stdio: "ignore",
      }),
    ).toThrow();
  });
});
