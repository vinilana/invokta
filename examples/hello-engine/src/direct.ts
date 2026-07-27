import { engine, localPrincipal } from "./engine.js";

const name = process.argv.slice(2).join(" ").trim() || "Developer";
const result = await engine.invoke(
  "onboarding.create-welcome-message",
  { name },
  { source: "direct", principal: localPrincipal },
);

process.stdout.write(`${JSON.stringify(result)}\n`);
