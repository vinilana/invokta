import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { environmentModuleTemplate } from "../src/scaffold/index.js";
import {
  compileScaffoldProject,
  createScaffoldProject,
  removeScaffoldProject,
  type ScaffoldProject,
} from "./support/init-scaffold-project.js";

const secretSentinel = "fixture-secret-payload-marker";
const overrideVariable = "AI_ENGINE_ENV_FILE";

type Environment = Record<string, string | undefined>;

interface LoadOptions {
  readonly env?: Environment;
  readonly cwd?: string;
}

interface LoaderModule {
  readonly loadEnvironmentFile: (options?: LoadOptions) => void;
  readonly requireEnvironment: (
    names: readonly string[],
    options?: LoadOptions,
  ) => void;
  readonly environmentStartupMessages: Readonly<Record<string, string>>;
  readonly environmentLoadLimits: Readonly<Record<string, number>>;
}

let project: ScaffoldProject;
let loaderPath: string;
let loader: LoaderModule;

const directories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-engine-env-"));
  directories.push(directory);
  return directory;
}

/** Writes one environment file and returns the directory that holds it. */
function withEnvironmentFile(
  contents: string | Uint8Array,
  name = ".env",
): string {
  const directory = createDirectory();
  const file = join(directory, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return directory;
}

function expectStartupFailure(run: () => void, message: string): Error {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  expect(error.message.startsWith(message)).toBe(true);
  return error;
}

beforeAll(async () => {
  project = createScaffoldProject({ "src/env.ts": environmentModuleTemplate });
  const compiled = compileScaffoldProject(project);
  expect(compiled.output).toBe("");
  expect(compiled.status).toBe(0);
  loaderPath = join(project.outputDirectory, "env.js");

  // The module loads an environment file when it is imported. An empty file
  // keeps that one unavoidable load observable and inert.
  const emptyFile = join(createDirectory(), "empty.env");
  writeFileSync(emptyFile, "", "utf8");
  const previousOverride = process.env[overrideVariable];
  process.env[overrideVariable] = emptyFile;
  try {
    loader = (await import(pathToFileURL(loaderPath).href)) as LoaderModule;
  } finally {
    if (previousOverride === undefined) delete process.env[overrideVariable];
    else process.env[overrideVariable] = previousOverride;
  }
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(() => {
  removeScaffoldProject(project);
});

describe("the generated environment loader", () => {
  it("leaves the environment untouched when no file and no override exist", () => {
    const environment: Environment = { EXISTING: "kept" };

    loader.loadEnvironmentFile({ cwd: createDirectory(), env: environment });

    expect(environment).toEqual({ EXISTING: "kept" });
  });

  it("fills an absent variable from the file", () => {
    const cwd = withEnvironmentFile("FROM_FILE=applied\n");
    const environment: Environment = {};

    loader.loadEnvironmentFile({ cwd, env: environment });

    expect(environment).toEqual({ FROM_FILE: "applied" });
  });

  it("never overrides a variable the environment already defines", () => {
    const cwd = withEnvironmentFile(
      "PRESENT=from-file\nPRESENT_EMPTY=from-file\nABSENT=from-file\n",
    );
    const environment: Environment = {
      PRESENT: "from-environment",
      PRESENT_EMPTY: "",
    };

    loader.loadEnvironmentFile({ cwd, env: environment });

    expect(environment).toEqual({
      PRESENT: "from-environment",
      PRESENT_EMPTY: "",
      ABSENT: "from-file",
    });
  });

  it("selects the file named by the override variable", () => {
    const cwd = withEnvironmentFile("FROM_DEFAULT=default\n");
    const overrideDirectory = withEnvironmentFile(
      "FROM_OVERRIDE=override\n",
      "custom.env",
    );
    const environment: Environment = {
      [overrideVariable]: join(overrideDirectory, "custom.env"),
    };

    loader.loadEnvironmentFile({ cwd, env: environment });

    expect(environment.FROM_OVERRIDE).toBe("override");
    expect(environment.FROM_DEFAULT).toBeUndefined();
  });

  it("resolves a relative override against the working directory", () => {
    const cwd = withEnvironmentFile(
      "FROM_RELATIVE=applied\n",
      "config/app.env",
    );
    const environment: Environment = { [overrideVariable]: "config/app.env" };

    loader.loadEnvironmentFile({ cwd, env: environment });

    expect(environment.FROM_RELATIVE).toBe("applied");
  });

  it("fails when the override names a missing or non-regular file", () => {
    const directory = createDirectory();
    mkdirSync(join(directory, "as-directory"));

    expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: directory,
          env: { [overrideVariable]: join(directory, "absent.env") },
        }),
      loader.environmentStartupMessages.FILE_NOT_FOUND ?? "",
    );
    expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: directory,
          env: { [overrideVariable]: join(directory, "as-directory") },
        }),
      loader.environmentStartupMessages.FILE_NOT_FOUND ?? "",
    );
  });

  it("refuses a symlinked environment file", () => {
    const directory = createDirectory();
    writeFileSync(join(directory, "real.env"), "LINKED=1\n", "utf8");
    symlinkSync(join(directory, "real.env"), join(directory, ".env"));
    const environment: Environment = {};

    expectStartupFailure(
      () => loader.loadEnvironmentFile({ cwd: directory, env: environment }),
      loader.environmentStartupMessages.FILE_UNSAFE ?? "",
    );
    expect(environment).toEqual({});
  });

  it("refuses an override path that contains a NUL character", () => {
    const error = expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: createDirectory(),
          env: { [overrideVariable]: `/tmp/app\u0000${secretSentinel}.env` },
        }),
      loader.environmentStartupMessages.FILE_UNSAFE ?? "",
    );

    expect(error.message).not.toContain(secretSentinel);
  });

  it("refuses a file that contains a NUL byte", () => {
    const cwd = withEnvironmentFile(new Uint8Array([65, 61, 49, 0, 10]));

    expectStartupFailure(
      () => loader.loadEnvironmentFile({ cwd, env: {} }),
      loader.environmentStartupMessages.FILE_UNSAFE ?? "",
    );
  });

  it("refuses undecodable content", () => {
    const cwd = withEnvironmentFile(new Uint8Array([65, 61, 0xff, 0xfe, 10]));

    expectStartupFailure(
      () => loader.loadEnvironmentFile({ cwd, env: {} }),
      loader.environmentStartupMessages.FILE_UNSAFE ?? "",
    );
  });
});

describe("the generated loader parsing dialect", () => {
  const fixtures = [
    "SIMPLE=value\n",
    "# comment\nAFTER_COMMENT=1\n",
    "SPACED = value with spaces \n",
    'QUOTED="value with # hash"\n',
    "SINGLE='single quoted'\n",
    "EMPTY=\n",
    "EQUALS=a=b\n",
    "DUPLICATE=first\nDUPLICATE=second\n",
    "export EXPORTED=1\n",
    'MULTILINE="line one\nline two"\n',
    "TRAILING=value   \n",
    "\nBLANK_LINES=1\n\n",
    "NO_NEWLINE_AT_EOF=1",
    "INLINE=1 # trailing comment\n",
  ] as const;

  for (const fixture of fixtures) {
    it(`applies exactly what util.parseEnv returns for ${JSON.stringify(fixture)}`, () => {
      const cwd = withEnvironmentFile(fixture);
      const environment: Environment = {};

      loader.loadEnvironmentFile({ cwd, env: environment });

      expect(environment).toEqual({ ...parseEnv(fixture) });
    });
  }
});

describe("the generated loader limits", () => {
  it("accepts a file of exactly the maximum size and refuses one byte more", () => {
    const maximum = loader.environmentLoadLimits.maxFileBytes ?? 0;
    const head = "SIZE_BOUND=1\n";
    const inclusive = `${head}${"#".repeat(maximum - head.length - 1)}\n`;
    expect(Buffer.byteLength(inclusive, "utf8")).toBe(maximum);
    const environment: Environment = {};

    loader.loadEnvironmentFile({
      cwd: withEnvironmentFile(inclusive),
      env: environment,
    });

    expect(environment).toEqual({ SIZE_BOUND: "1" });
    expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: withEnvironmentFile(`${inclusive}#`),
          env: {},
        }),
      loader.environmentStartupMessages.FILE_UNSAFE ?? "",
    );
  });

  it("accepts the maximum number of applied keys and refuses one more", () => {
    const maximum = loader.environmentLoadLimits.maxAppliedKeys ?? 0;
    const body = (count: number): string =>
      Array.from({ length: count }, (_, index) => `KEY_${index}=1\n`).join("");
    const environment: Environment = {};

    loader.loadEnvironmentFile({
      cwd: withEnvironmentFile(body(maximum)),
      env: environment,
    });

    expect(Object.keys(environment)).toHaveLength(maximum);
    const rejected: Environment = {};
    expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: withEnvironmentFile(body(maximum + 1)),
          env: rejected,
        }),
      loader.environmentStartupMessages.LIMIT_EXCEEDED ?? "",
    );
    expect(rejected).toEqual({});
  });

  it("counts only applicable keys against the key limit", () => {
    const maximum = loader.environmentLoadLimits.maxAppliedKeys ?? 0;
    const body = Array.from(
      { length: maximum + 1 },
      (_, index) => `KEY_${index}=1\n`,
    ).join("");
    const environment: Environment = { KEY_0: "from-environment" };

    loader.loadEnvironmentFile({
      cwd: withEnvironmentFile(body),
      env: environment,
    });

    expect(environment.KEY_0).toBe("from-environment");
    expect(Object.keys(environment)).toHaveLength(maximum + 1);
  });

  it("accepts the maximum value length and refuses one scalar more", () => {
    const maximum = loader.environmentLoadLimits.maxValueScalars ?? 0;
    const environment: Environment = {};

    loader.loadEnvironmentFile({
      cwd: withEnvironmentFile(`VALUE_BOUND=${"a".repeat(maximum)}\n`),
      env: environment,
    });

    expect(environment.VALUE_BOUND).toHaveLength(maximum);
    expectStartupFailure(
      () =>
        loader.loadEnvironmentFile({
          cwd: withEnvironmentFile(`VALUE_BOUND=${"a".repeat(maximum + 1)}\n`),
          env: {},
        }),
      loader.environmentStartupMessages.LIMIT_EXCEEDED ?? "",
    );
  });

  it("measures a value in Unicode scalar values rather than code units", () => {
    const maximum = loader.environmentLoadLimits.maxValueScalars ?? 0;
    const environment: Environment = {};

    loader.loadEnvironmentFile({
      cwd: withEnvironmentFile(`ASTRAL=${"\u{1f600}".repeat(maximum)}\n`),
      env: environment,
    });

    expect(environment.ASTRAL).toHaveLength(maximum * 2);
  });
});

describe("the generated loader key validation", () => {
  it("aborts naming an applicable key that fails the name pattern", () => {
    const cwd = withEnvironmentFile(`lowercase=${secretSentinel}\nVALID=1\n`);
    const environment: Environment = {};

    const error = expectStartupFailure(
      () => loader.loadEnvironmentFile({ cwd, env: environment }),
      loader.environmentStartupMessages.NAME_INVALID ?? "",
    );

    expect(error.message).toContain("lowercase");
    expect(error.message).not.toContain(secretSentinel);
    expect(environment).toEqual({});
  });

  it("exempts a key that already exists in the environment", () => {
    const cwd = withEnvironmentFile("lowercase=from-file\nVALID=1\n");
    const environment: Environment = { lowercase: "from-environment" };

    loader.loadEnvironmentFile({ cwd, env: environment });

    expect(environment).toEqual({ lowercase: "from-environment", VALID: "1" });
  });
});

describe("the generated required-variable check", () => {
  it("accepts declared names that are present and non-empty", () => {
    expect(() =>
      loader.requireEnvironment(["PRESENT"], { env: { PRESENT: "value" } }),
    ).not.toThrow();
  });

  it("lists missing and empty names in declaration order without any value", () => {
    const environment: Environment = {
      SECOND: "",
      FOURTH: secretSentinel,
    };

    const error = expectStartupFailure(
      () =>
        loader.requireEnvironment(["FIRST", "SECOND", "THIRD", "FOURTH"], {
          env: environment,
        }),
      loader.environmentStartupMessages.REQUIRED_MISSING ?? "",
    );

    expect(error.message).toContain("FIRST, SECOND, THIRD");
    expect(error.message).not.toContain("FOURTH");
    expect(error.message).not.toContain(secretSentinel);
    expect(error.stack ?? "").not.toContain(secretSentinel);
  });
});

describe("the generated loader secret hygiene", () => {
  it("never reports a value from the environment file", () => {
    const cases: readonly (() => void)[] = [
      () =>
        loader.loadEnvironmentFile({
          cwd: withEnvironmentFile(`BAD-NAME=${secretSentinel}\n`),
          env: {},
        }),
      () =>
        loader.loadEnvironmentFile({
          cwd: withEnvironmentFile(
            `HUGE=${secretSentinel}${"a".repeat(5000)}\n`,
          ),
          env: {},
        }),
      () =>
        loader.requireEnvironment(["MISSING"], {
          env: { OTHER: secretSentinel },
        }),
    ];

    for (const run of cases) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(`${error.message}${error.stack ?? ""}`).not.toContain(
        secretSentinel,
      );
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("importing the generated loader", () => {
  it("applies the environment file as an import side effect", async () => {
    const directory = createDirectory();
    const file = join(directory, "startup.env");
    writeFileSync(file, "AI_ENGINE_SCAFFOLD_IMPORT_PROBE=applied\n", "utf8");
    const copy = join(project.outputDirectory, "env-import-probe.mjs");
    copyFileSync(loaderPath, copy);
    const previousOverride = process.env[overrideVariable];
    process.env[overrideVariable] = file;

    try {
      await import(pathToFileURL(copy).href);
      expect(process.env.AI_ENGINE_SCAFFOLD_IMPORT_PROBE).toBe("applied");
    } finally {
      delete process.env.AI_ENGINE_SCAFFOLD_IMPORT_PROBE;
      if (previousOverride === undefined) delete process.env[overrideVariable];
      else process.env[overrideVariable] = previousOverride;
    }
  });
});
