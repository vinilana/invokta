import type { DeployManifestEnvironment } from "../manifest.js";

const header = `# Environment values for local development.
#
# Copy this file to .env and fill in each value. A variable the real
# environment already defines always wins, so .env never overrides platform
# configuration. Never commit .env and never copy it into a container image.
`;

const noDeclaredNames = `
# This engine declares no environment variable names. Declare them under
# "env" in ai-engine.deploy.json.
`;

function renderGroup(comment: string, names: readonly string[]): string {
  if (names.length === 0) return "";
  const lines = names.map((name) => `${name}=`).join("\n");
  return `\n${comment}\n${lines}\n`;
}

/**
 * Renders `.env.example` from the manifest's declared names: the required
 * group first, then the optional one, each in declaration order and with an
 * empty value. The file is secret-free by construction and safe to commit.
 */
export function renderEnvironmentExample(
  environment: DeployManifestEnvironment,
): string {
  const groups = `${renderGroup("# Required by this engine.", environment.required)}${renderGroup("# Optional.", environment.optional)}`;
  return `${header}${groups === "" ? noDeclaredNames : groups}`;
}
