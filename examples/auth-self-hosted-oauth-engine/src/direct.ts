import { engine } from "./engine.js";
import { localPrincipal } from "./local-principal.js";

const result = await engine.invoke(
  "identity.whoami",
  {},
  { source: "direct", principal: localPrincipal() },
);

process.stdout.write(`${JSON.stringify(result)}\n`);
