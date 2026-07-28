import type { HttpDeployManifest } from "../manifest.js";
import { entryOutputPath, entryPosixPath } from "./entry.js";
import type { PackageManagerStrategy } from "./lockfile.js";
import { generatedFileMarkerLine } from "./marker.js";

export interface DockerfileInput {
  readonly manifest: HttpDeployManifest;
  readonly packageManager: PackageManagerStrategy;
}

export const healthcheckScriptPath = "deploy/healthcheck.mjs";

/**
 * Renders the container build. Both stages use the manifest base image: the
 * build stage restores the exact lockfile tree, runs the project build script,
 * and prunes to production dependencies; the runtime stage receives only the
 * built output and runs it as the unprivileged `node` user. Nothing here is
 * executed by the toolkit, and no credential or environment file is copied.
 */
export function renderDockerfile(input: DockerfileInput): string {
  const { manifest, packageManager } = input;
  const image = manifest.image.baseImage;
  const output = entryOutputPath(manifest.entry);
  const entry = entryPosixPath(manifest.entry);
  const port = String(manifest.image.port);

  return `${generatedFileMarkerLine("hash")}
#
# Multi-stage build for an MCP Streamable HTTP engine. The build stage installs
# from the committed lockfile, runs the project build script, and prunes to
# production dependencies. The runtime stage carries only what the server runs.

FROM ${image} AS build
WORKDIR /app
COPY . .
RUN ${packageManager.install}
RUN ${packageManager.build}
RUN ${packageManager.prune}

FROM ${image} AS runtime
ENV NODE_ENV=production
ENV AI_ENGINE_HTTP_HOST=0.0.0.0
ENV AI_ENGINE_HTTP_PORT=${port}
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/${output} ./${output}
COPY --from=build /app/${healthcheckScriptPath} ./${healthcheckScriptPath}
USER node
EXPOSE ${port}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "${healthcheckScriptPath}"]
CMD ["node", "${entry}"]
`;
}
