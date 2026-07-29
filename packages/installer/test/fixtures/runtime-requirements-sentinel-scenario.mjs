import { createNodeExecutableResolver } from "../../dist/node-harness-environment.js";
import { resolveRuntimeRequirements } from "../../dist/runtime-requirements.js";

const executablePath = process.env.INVOKTA_INSTALLER_RUNTIME_EXECUTABLE;
const secret = process.env.INVOKTA_INSTALLER_RUNTIME_SECRET;
if (executablePath === undefined || secret === undefined) {
  throw new Error("Runtime sentinel inputs are required.");
}

let resolverCalls = 0;
const nodeResolver = createNodeExecutableResolver();
const resolveExecutable = async (candidate) => {
  resolverCalls += 1;
  return nodeResolver(candidate);
};
const environment = {
  get(name) {
    return name === "SUPPORT_API_TOKEN" ? secret : undefined;
  },
};

const stdio = await resolveRuntimeRequirements({
  action: "install",
  descriptor: {
    name: "invokta-support",
    transport: {
      type: "stdio",
      command: executablePath,
      args: ["--transport", "stdio"],
      forwardEnv: ["SUPPORT_API_TOKEN"],
    },
  },
  resolveExecutable,
  environment,
});
const http = await resolveRuntimeRequirements({
  action: "enable",
  descriptor: {
    name: "invokta-support",
    transport: {
      type: "streamable-http",
      url: "https://support.example/mcp",
      authentication: {
        type: "bearer-env",
        variable: "SUPPORT_API_TOKEN",
      },
      headersFromEnv: {},
    },
  },
  resolveExecutable,
  environment,
});

process.stdout.write(`${JSON.stringify({ stdio, http, resolverCalls })}\n`);
