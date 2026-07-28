import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const configuredRoot = process.env.AI_ENGINE_INSTALLER_DIST_ROOT;
if (configuredRoot === undefined || configuredRoot === "") {
  throw new Error("AI_ENGINE_INSTALLER_DIST_ROOT is required by the loader.");
}

const distRoot = `${pathToFileURL(resolvePath(configuredRoot)).href}/`;
const allowedInstallerModules = new Set(
  ["cli.js", "run-installer-cli.js", "installer-error.js"].map(
    (name) => `${distRoot}${name}`,
  ),
);
const packageManifest = new URL("../package.json", distRoot).href;

function rejectUnexpectedModule(specifier) {
  throw new Error(`Unexpected eager installer module: ${specifier}`);
}

export async function resolve(specifier, context, nextResolve) {
  const resolution = await nextResolve(specifier, context);
  if (!allowedInstallerModules.has(context.parentURL)) return resolution;
  if (allowedInstallerModules.has(resolution.url)) return resolution;
  if (
    context.parentURL === `${distRoot}run-installer-cli.js` &&
    resolution.url === packageManifest
  ) {
    return resolution;
  }
  return rejectUnexpectedModule(specifier);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(distRoot) && !allowedInstallerModules.has(url)) {
    return rejectUnexpectedModule(url);
  }
  return nextLoad(url, context);
}
