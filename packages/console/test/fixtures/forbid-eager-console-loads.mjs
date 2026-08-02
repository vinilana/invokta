import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

function requiredRoot(name) {
  const configured = process.env[name];
  if (configured === undefined || configured === "") {
    throw new Error(`${name} is required by the loader.`);
  }
  return `${pathToFileURL(resolvePath(configured)).href}/`;
}

const distRoot = requiredRoot("INVOKTA_CONSOLE_DIST_ROOT");
const coreDistRoot = requiredRoot("INVOKTA_CLIENT_CONFIG_DIST_ROOT");

const allowedConsoleModules = new Set(
  ["cli.js", "run-console-cli.js"].map((name) => `${distRoot}${name}`),
);
// The console may reach the core only through its dependency-free diagnostic
// subpath. Touching the barrel would pull every configuration format parser,
// and the HTTP server, into the usage and version paths.
const allowedCoreModules = new Set(
  ["errors.js", "installer-error.js"].map((name) => `${coreDistRoot}${name}`),
);
const packageManifest = new URL("../package.json", distRoot).href;

function rejectUnexpectedModule(specifier) {
  throw new Error(`Unexpected eager console module: ${specifier}`);
}

export async function resolve(specifier, context, nextResolve) {
  const resolution = await nextResolve(specifier, context);
  const parent = context.parentURL;
  if (!allowedConsoleModules.has(parent) && !allowedCoreModules.has(parent)) {
    return resolution;
  }
  if (
    allowedConsoleModules.has(resolution.url) ||
    allowedCoreModules.has(resolution.url)
  ) {
    return resolution;
  }
  if (
    parent === `${distRoot}run-console-cli.js` &&
    resolution.url === packageManifest
  ) {
    return resolution;
  }
  return rejectUnexpectedModule(specifier);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(distRoot) && !allowedConsoleModules.has(url)) {
    return rejectUnexpectedModule(url);
  }
  if (url.startsWith(coreDistRoot) && !allowedCoreModules.has(url)) {
    return rejectUnexpectedModule(url);
  }
  return nextLoad(url, context);
}
