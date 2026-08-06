import { appendFileSync } from "node:fs";

import { createEngine, defineCapability } from "@invokta/core";
import { serveMcpStdio } from "@invokta/mcp";
import { z } from "zod";

const auditPath = process.env.VERIFY_MCP_AUDIT_FILE;
if (auditPath === undefined || auditPath === "") {
  throw new Error("The verification fixture requires an audit file.");
}

function audit(record) {
  appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
}

const engine = createEngine({
  name: "verify-integration-stdio",
  version: "1.0.0",
  capabilities: {
    "fixture.read-only": defineCapability({
      description: "A tool that verification must advertise but never call.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        audit({ kind: "handler", operation: "tools/call" });
        return { ok: true };
      },
    }),
  },
});

let readBuffer = "";
function observeProtocol(chunk) {
  readBuffer += Buffer.from(chunk).toString("utf8");
  let newline = readBuffer.indexOf("\n");
  while (newline >= 0) {
    const line = readBuffer.slice(0, newline);
    readBuffer = readBuffer.slice(newline + 1);
    if (line !== "") {
      const message = JSON.parse(line);
      if (typeof message.method === "string") {
        audit({
          kind: "message",
          method: message.method,
          ...(message.method === "tools/list" &&
          typeof message.params === "object" &&
          message.params !== null &&
          "cursor" in message.params
            ? { cursor: message.params.cursor }
            : {}),
        });
      }
    }
    newline = readBuffer.indexOf("\n");
  }
}

process.stdin.on("data", observeProtocol);
process.once("exit", () => {
  audit({ kind: "lifecycle", state: "exited" });
});

await serveMcpStdio(engine);
process.stdin.off("data", observeProtocol);
audit({ kind: "lifecycle", state: "closed" });
