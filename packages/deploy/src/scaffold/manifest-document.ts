import {
  deployManifestDefaults,
  type HttpDeployManifest,
} from "../manifest.js";

/**
 * The manifest `init` writes when a project has none. Every documented default
 * is spelled out rather than omitted, because the schema is closed and the
 * file is meant to be edited by hand.
 */
export const starterDeployManifest: HttpDeployManifest = Object.freeze({
  schemaVersion: 1,
  entry: "dist/mcp-http.js",
  env: Object.freeze({
    required: Object.freeze([]),
    optional: Object.freeze([]),
  }),
  image: Object.freeze({
    baseImage: deployManifestDefaults.baseImage,
    port: deployManifestDefaults.port,
  }),
  healthcheck: Object.freeze({ expect: deployManifestDefaults.expect }),
});

/**
 * Renders one manifest as the JSON document on disk. The key order is the
 * schema's own, so the same manifest always renders the same bytes.
 */
export function renderDeployManifestDocument(
  manifest: HttpDeployManifest,
): string {
  const document = {
    schemaVersion: manifest.schemaVersion,
    entry: manifest.entry,
    env: {
      required: [...manifest.env.required],
      optional: [...manifest.env.optional],
    },
    image: {
      baseImage: manifest.image.baseImage,
      port: manifest.image.port,
    },
    healthcheck: {
      expect: manifest.healthcheck.expect,
      ...(manifest.healthcheck.bearerEnv === undefined
        ? {}
        : { bearerEnv: manifest.healthcheck.bearerEnv }),
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
