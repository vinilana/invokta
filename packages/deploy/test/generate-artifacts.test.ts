import { describe, expect, it } from "vitest";

import { DeployError } from "../src/errors.js";
import { entryOutputPath, entryPosixPath } from "../src/generate/entry.js";
import {
  type PackageManagerId,
  packageManagerStrategies,
  selectPackageManager,
  supportedLockfileNames,
} from "../src/generate/lockfile.js";
import {
  deployToolkitMajorVersion,
  generatedFileMarkerLine,
  generatedFileMarkerText,
  hasGeneratedFileMarker,
} from "../src/generate/marker.js";
import {
  type GeneratedFile,
  generatedFilePaths,
  planGeneratedFiles,
} from "../src/generate/plan.js";
import { parseProjectPackage } from "../src/generate/project-package.js";
import { parseDeployManifest } from "../src/manifest.js";

const hashMarker = generatedFileMarkerLine("hash");
const lineMarker = generatedFileMarkerLine("line");
const htmlMarker = generatedFileMarkerLine("html");

function manifestOf(document: Readonly<Record<string, unknown>>) {
  const result = parseDeployManifest(
    JSON.stringify({
      schemaVersion: 1,
      entry: "dist/mcp-http.js",
      ...document,
    }),
  );
  if (!result.ok) {
    throw new Error(
      `the fixture manifest is invalid: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.manifest;
}

const project = parseProjectPackage(
  JSON.stringify({
    name: "support-engine",
    version: "1.4.2",
    scripts: { build: "tsc -b" },
  }),
);

function plan(
  manager: PackageManagerId,
  document: Readonly<Record<string, unknown>> = {},
): readonly GeneratedFile[] {
  return planGeneratedFiles({
    manifest: manifestOf(document),
    packageManager: packageManagerStrategies[manager],
    project,
  });
}

function fileAt(files: readonly GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no generated file at ${path}`);
  return file;
}

function contentsAt(
  manager: PackageManagerId,
  path: string,
  document: Readonly<Record<string, unknown>> = {},
): string {
  return fileAt(plan(manager, document), path).contents;
}

const goldenDockerfile = `${hashMarker}
#
# Multi-stage build for an MCP Streamable HTTP engine. The build stage installs
# from the committed lockfile, runs the project build script, and prunes to
# production dependencies. The runtime stage carries only what the server runs.

FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV INVOKTA_HTTP_HOST=0.0.0.0
ENV INVOKTA_HTTP_PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/deploy/healthcheck.mjs ./deploy/healthcheck.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "dist/mcp-http.js"]
`;

const goldenDockerignore = `${hashMarker}
.git
.gitignore
node_modules
**/node_modules
test
coverage
.env*
**/.env*
Dockerfile
.dockerignore
`;

describe("generated file marker", () => {
  it("names the toolkit and its major version in every comment syntax", () => {
    expect(generatedFileMarkerText).toContain("invokta-deploy");
    expect(generatedFileMarkerText).toContain(`v${deployToolkitMajorVersion}`);
    expect(hashMarker).toBe(`# ${generatedFileMarkerText}`);
    expect(lineMarker).toBe(`// ${generatedFileMarkerText}`);
    expect(htmlMarker).toBe(`<!-- ${generatedFileMarkerText} -->`);
  });

  it("tracks the published major version of the toolkit", async () => {
    const namespace = (await import("../package.json", {
      with: { type: "json" },
    })) as { readonly default: { readonly version: string } };
    const major = Number(namespace.default.version.split(".")[0]);

    expect(deployToolkitMajorVersion).toBe(major);
  });

  it("recognizes the marker only on the first line", () => {
    expect(hasGeneratedFileMarker(`${hashMarker}\nFROM node\n`, "hash")).toBe(
      true,
    );
    expect(hasGeneratedFileMarker(`${hashMarker}\r\nFROM node\n`, "hash")).toBe(
      true,
    );
    expect(hasGeneratedFileMarker(hashMarker, "hash")).toBe(true);
    expect(hasGeneratedFileMarker(`FROM node\n${hashMarker}\n`, "hash")).toBe(
      false,
    );
    expect(hasGeneratedFileMarker(`# hand written\n`, "hash")).toBe(false);
    expect(hasGeneratedFileMarker("", "hash")).toBe(false);
    expect(hasGeneratedFileMarker(`${hashMarker}\n`, "line")).toBe(false);
  });
});

describe("lockfile detection", () => {
  it("supports exactly the three documented lockfiles", () => {
    expect([...supportedLockfileNames]).toEqual([
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
  });

  it.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const)("maps %s to its package manager", (lockfile, id) => {
    expect(selectPackageManager([lockfile]).id).toBe(id);
  });

  it("rejects a project with no lockfile", () => {
    try {
      selectPackageManager([]);
      throw new Error("expected the selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe("LOCKFILE_MISSING");
      expect((error as DeployError).exitCode).toBe(1);
    }
  });

  it("rejects a project with more than one lockfile", () => {
    try {
      selectPackageManager(["yarn.lock", "package-lock.json"]);
      throw new Error("expected the selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe("LOCKFILE_AMBIGUOUS");
      expect((error as DeployError).details).toEqual([
        "package-lock.json",
        "yarn.lock",
      ]);
    }
  });
});

describe("project package.json", () => {
  it("reads the fields the generators depend on", () => {
    expect(project).toEqual({
      buildScript: "tsc -b",
      name: "support-engine",
      version: "1.4.2",
    });
  });

  it.each([
    ["not JSON at all", "{"],
    ["a JSON array", "[]"],
    [
      "a missing name",
      JSON.stringify({ scripts: { build: "x" }, version: "1.0.0" }),
    ],
    [
      "an empty name",
      JSON.stringify({ name: "", scripts: { build: "x" }, version: "1.0.0" }),
    ],
    [
      "a missing version",
      JSON.stringify({ name: "e", scripts: { build: "x" } }),
    ],
    ["missing scripts", JSON.stringify({ name: "e", version: "1.0.0" })],
    [
      "a missing build script",
      JSON.stringify({ name: "e", scripts: {}, version: "1.0.0" }),
    ],
    [
      "a control character in the name",
      JSON.stringify({
        name: "a\nb",
        scripts: { build: "x" },
        version: "1.0.0",
      }),
    ],
  ])("rejects %s", (_label, text) => {
    try {
      parseProjectPackage(text);
      throw new Error("expected the package.json to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe("PACKAGE_JSON_INVALID");
      expect((error as DeployError).exitCode).toBe(1);
    }
  });

  it("never echoes a rejected value", () => {
    const secret = "sentinel-value-that-must-never-be-echoed";
    try {
      parseProjectPackage(JSON.stringify({ name: secret, version: 7 }));
      throw new Error("expected the package.json to be rejected");
    } catch (error) {
      const rendered = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(rendered).not.toContain(secret);
    }
  });
});

describe("entry paths", () => {
  it.each([
    ["dist/mcp-http.js", "dist/mcp-http.js", "dist"],
    ["build\\server.mjs", "build/server.mjs", "build"],
    ["server.js", "server.js", "server.js"],
    ["out/http/server.js", "out/http/server.js", "out"],
  ])("normalizes %s", (entry, posix, output) => {
    expect(entryPosixPath(entry)).toBe(posix);
    expect(entryOutputPath(entry)).toBe(output);
  });
});

describe("generated file set", () => {
  it("plans exactly the four documented files in lexicographic order", () => {
    expect([...generatedFilePaths]).toEqual([
      ".dockerignore",
      "Dockerfile",
      "deploy/DEPLOYMENT.md",
      "deploy/healthcheck.mjs",
    ]);
    expect(plan("npm").map((file) => file.path)).toEqual([
      ...generatedFilePaths,
    ]);
  });

  it("starts every generated file with its marker line", () => {
    for (const file of plan("pnpm")) {
      expect(file.contents.startsWith(`${file.markerLine}\n`)).toBe(true);
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents).not.toContain("\r");
    }
  });

  it("is a pure function of its inputs", () => {
    expect(plan("yarn").map((file) => file.contents)).toEqual(
      plan("yarn").map((file) => file.contents),
    );
  });

  it("contains no timestamp, absolute path, or machine identity", () => {
    const date = /\b20\d{2}-\d{2}-\d{2}\b/u;
    for (const file of plan("npm", {
      env: { required: ["SUPPORT_API_TOKEN"] },
      healthcheck: { expect: "ready", bearerEnv: "SUPPORT_API_TOKEN" },
      image: { baseImage: "node:22-alpine", port: 8080 },
    })) {
      // The pinned MCP protocol version is a contract, not a build stamp.
      const scanned = file.contents.replaceAll("2025-11-25", "");
      expect(scanned).not.toMatch(date);
      expect(file.contents).not.toContain(process.cwd());
      expect(file.contents.toLowerCase()).not.toContain(
        (process.env.USER ?? "no-such-user-name").toLowerCase(),
      );
    }
  });
});

describe("Dockerfile", () => {
  it("matches the golden multi-stage build for npm", () => {
    expect(contentsAt("npm", "Dockerfile")).toBe(goldenDockerfile);
  });

  it.each([
    ["npm", ["RUN npm ci", "RUN npm run build", "RUN npm ci --omit=dev"]],
    [
      "pnpm",
      [
        "RUN pnpm install --frozen-lockfile",
        "RUN pnpm run build",
        "RUN pnpm install --prod --frozen-lockfile",
      ],
    ],
    [
      "yarn",
      [
        "RUN yarn install --frozen-lockfile",
        "RUN yarn run build",
        "RUN yarn install --production --frozen-lockfile",
      ],
    ],
  ] as const)(
    "runs the %s install, build, and prune commands",
    (manager, commands) => {
      const lines = contentsAt(manager, "Dockerfile").split("\n");

      expect(lines.filter((line) => line.startsWith("RUN "))).toEqual([
        ...commands,
      ]);
    },
  );

  it("honors the manifest base image, port, and entry", () => {
    const dockerfile = contentsAt("npm", "Dockerfile", {
      entry: "build/http/server.mjs",
      image: { baseImage: "node:22-alpine", port: 8080 },
    });

    expect(dockerfile).toContain("FROM node:22-alpine AS build\n");
    expect(dockerfile).toContain("FROM node:22-alpine AS runtime\n");
    expect(dockerfile).toContain("EXPOSE 8080\n");
    expect(dockerfile).toContain("ENV INVOKTA_HTTP_PORT=8080\n");
    expect(dockerfile).toContain("COPY --from=build /app/build ./build\n");
    expect(dockerfile).toContain('CMD ["node", "build/http/server.mjs"]\n');
  });

  it("copies a root-level entry file when the build emits no directory", () => {
    const dockerfile = contentsAt("npm", "Dockerfile", { entry: "server.js" });

    expect(dockerfile).toContain(
      "COPY --from=build /app/server.js ./server.js",
    );
    expect(dockerfile).toContain('CMD ["node", "server.js"]');
  });

  it("runs as the non-root node user and declares the health check", () => {
    const dockerfile = contentsAt("npm", "Dockerfile");

    expect(dockerfile).toContain("\nUSER node\n");
    expect(dockerfile).toContain("ENV NODE_ENV=production\n");
    expect(dockerfile).toContain("ENV INVOKTA_HTTP_HOST=0.0.0.0\n");
    expect(dockerfile).toContain('CMD ["node", "deploy/healthcheck.mjs"]');
    expect(dockerfile).toContain("HEALTHCHECK ");
  });

  it("carries no credential, token, or environment file into the image", () => {
    const dockerfile = contentsAt("npm", "Dockerfile", {
      env: { required: ["SUPPORT_API_TOKEN"] },
    });

    for (const forbidden of [
      "SUPPORT_API_TOKEN",
      ".env",
      "ARG NPM_TOKEN",
      "--mount=type=secret",
      "_auth",
    ]) {
      expect(dockerfile).not.toContain(forbidden);
    }
  });
});

describe(".dockerignore", () => {
  it("matches the golden exclusion list", () => {
    expect(contentsAt("npm", ".dockerignore")).toBe(goldenDockerignore);
  });

  it("excludes every environment file from the build context", () => {
    const lines = contentsAt("yarn", ".dockerignore").split("\n");

    expect(lines).toContain(".env*");
    expect(lines).toContain("**/.env*");
    for (const required of [".git", "node_modules", "test", "coverage"]) {
      expect(lines).toContain(required);
    }
  });
});

describe("deploy/DEPLOYMENT.md", () => {
  const document = contentsAt("pnpm", "deploy/DEPLOYMENT.md", {
    env: {
      required: ["SUPPORT_API_TOKEN"],
      optional: ["INVOKTA_HTTP_ALLOWED_ORIGINS"],
    },
    healthcheck: { expect: "ready", bearerEnv: "SUPPORT_API_TOKEN" },
    image: { port: 8080 },
  });

  it("documents the environment contract of the composition root", () => {
    for (const variable of [
      "INVOKTA_HTTP_HOST",
      "INVOKTA_HTTP_PORT",
      "PORT",
      "INVOKTA_HTTP_ALLOWED_HOSTS",
      "INVOKTA_HTTP_ALLOWED_ORIGINS",
      "INVOKTA_HTTP_MAX_BODY_BYTES",
    ]) {
      expect(document).toContain(variable);
    }
    expect(document).toContain("`INVOKTA_HTTP_PORT` wins");
  });

  it("lists the variables declared by the manifest", () => {
    expect(document).toContain("SUPPORT_API_TOKEN");
    expect(document).toContain("## Declared variables");
  });

  it("states the topology rules operators must follow", () => {
    for (const phrase of [
      "TLS",
      "HTTPS",
      "/mcp",
      "raw `Host` header",
      "INVOKTA_HTTP_ALLOWED_HOSTS",
      "browser",
      "stateless",
      "horizontally",
      "HTTP 200",
    ]) {
      expect(document).toContain(phrase);
    }
  });

  it("documents the health check derived from the manifest", () => {
    expect(document).toContain("deploy/healthcheck.mjs");
    expect(document).toContain("8080");
    expect(document).toContain("`ready`");
    expect(document).toContain("SUPPORT_API_TOKEN");
    expect(document).toContain("3,000 ms");
  });

  it("documents the environment file convention and its precedence", () => {
    expect(document).toContain("## Environment files");
    expect(document).toContain("`.env`");
    expect(document).toContain("INVOKTA_ENV_FILE");
    expect(document).toContain(
      "process environment, then the environment file, then the defaults",
    );
    expect(document).toContain("never commit");
  });

  it("reports an engine that declares no variables without an empty table", () => {
    const bare = contentsAt("npm", "deploy/DEPLOYMENT.md");

    expect(bare).toContain("The manifest declares no required variables.");
    expect(bare).toContain("The manifest declares no optional variables.");
  });

  it("distinguishes health, OAuth discovery, and interactive authorization", () => {
    expect(document).toContain("invokta-deploy inspect-oauth");
    expect(document).toContain("perform login, consent, or token exchange");
    expect(document).toContain("interactive OAuth client");
  });
});
