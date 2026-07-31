import {
  deployManifestFileName,
  type HttpDeployManifest,
} from "../manifest.js";
import { httpAuthModuleTemplate } from "./auth-module.js";
import { renderEnvironmentExample } from "./env-example.js";
import { environmentModuleTemplate } from "./env-module.js";
import { renderHttpRootModule } from "./http-root-module.js";
import { renderDeployManifestDocument } from "./manifest-document.js";

export { httpAuthModuleTemplate } from "./auth-module.js";
export { renderEnvironmentExample } from "./env-example.js";
export { environmentModuleTemplate } from "./env-module.js";
export { renderHttpRootModule } from "./http-root-module.js";
export {
  renderDeployManifestDocument,
  starterDeployManifest,
} from "./manifest-document.js";

export interface McpHttpScaffoldFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
}

/**
 * Builds the file set `init` writes, in lexicographic path order. The manifest
 * parameterizes the example file and the required-name check, so the manifest,
 * `.env.example`, and the startup check cannot disagree.
 */
export function createMcpHttpScaffoldFiles(
  manifest: HttpDeployManifest,
): readonly McpHttpScaffoldFile[] {
  return Object.freeze([
    Object.freeze({
      path: ".env.example",
      contents: renderEnvironmentExample(manifest.env),
    }),
    Object.freeze({
      path: deployManifestFileName,
      contents: renderDeployManifestDocument(manifest),
    }),
    Object.freeze({ path: "src/env.ts", contents: environmentModuleTemplate }),
    Object.freeze({
      path: "src/http-auth.ts",
      contents: httpAuthModuleTemplate,
    }),
    Object.freeze({
      path: "src/mcp-http.ts",
      contents: renderHttpRootModule(manifest),
    }),
  ]);
}
