import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildCliTarget,
  cliPrimaryTabs,
  refreshFailureIsDisconnect,
} from "../src/ui/cli-app.js";

const uiDirectory = fileURLToPath(new URL("../src/ui/", import.meta.url));

describe("CLI workbench UI contract", () => {
  it("exposes Commands, Activity, and Connection only", () => {
    expect(cliPrimaryTabs).toEqual(["Commands", "Activity", "Connection"]);
  });

  it("builds a structured CLI target without a shell command string", () => {
    expect(
      buildCliTarget({
        command: "node",
        args: ["dist/cli.js", "--tenant", "alpha"],
        cwd: "/workspace/engine",
        environment: [
          { name: "API_TOKEN", value: "canary-token" },
          { name: "REGION", value: "south" },
        ],
      }),
    ).toEqual({
      command: "node",
      args: ["dist/cli.js", "--tenant", "alpha"],
      cwd: "/workspace/engine",
      env: { API_TOKEN: "canary-token", REGION: "south" },
    });
  });

  it("ships the CLI workbench chrome, copy, and shortcut overlay", () => {
    const app = readFileSync(`${uiDirectory}/cli-app.ts`, "utf8");
    const server = readFileSync(
      fileURLToPath(new URL("../src/cli-attached-server.ts", import.meta.url)),
      "utf8",
    );
    const styles = readFileSync(`${uiDirectory}/attached-styles.ts`, "utf8");

    expect(server).toContain("<title>Invokta DevTools · CLI workbench</title>");
    expect(app).toContain('["DevTools"]');
    expect(app).not.toContain('["devtools"]');
    expect(app).toContain('["CLI workbench"]');
    expect(app).toContain("Attach one Invokta CLI");
    expect(app).toContain("This is the CLI workbench.");
    expect(app).toContain("invokta-devtools");
    expect(app).toContain("open");
    expect(app).toContain("invokta-devtools serve dist/engine.js");
    expect(app).toContain("yarn devtools");
    expect(app).toContain(
      "This CLI uses its own composition root. DevTools does not supply a principal. Each verb starts a new process and the process exits.",
    );
    expect(app).toContain("Commands");
    expect(app).toContain("Activity");
    expect(app).toContain("Connection");
    expect(app).toContain('"Format JSON"');
    expect(app).toContain('"Reset to schema"');
    expect(app).toContain("Ctrl/⌘ + Enter");
    expect(app).toContain("Keyboard shortcuts");
    expect(app).toContain("Toggle this overlay");
    expect(server).toContain(
      "The Invokta DevTools interface requires JavaScript.",
    );
    expect(app).not.toContain("Doctor");
    expect(app).not.toContain("Test identities");
    expect(app).not.toContain("Playground");
    expect(app).not.toContain("Capabilities");
    expect(app).not.toContain("OAuth");
    expect(app).not.toContain("adapter chip");
    expect(styles).toMatch(/body\.attached-mode \{[^}]*font-size: 0\.875rem/s);
    expect(styles).toContain("90rem");
  });

  it("keeps target data out of browser storage", () => {
    const app = readFileSync(`${uiDirectory}/cli-app.ts`, "utf8");
    expect(app).not.toMatch(/localStorage|sessionStorage/);
    expect(app).not.toContain('el("style"');
    expect(app).toContain('href: "/assets/attached.css"');
    expect(app).toContain('type: "password"');
    expect(app).toContain("completeConnectionAttempt");
    expect(app).toContain("Cleared after response");
  });

  it("treats Refresh failures except TARGET_BUSY as disconnect", () => {
    expect(refreshFailureIsDisconnect("TIMEOUT")).toBe(true);
    expect(refreshFailureIsDisconnect("PROTOCOL_ERROR")).toBe(true);
    expect(refreshFailureIsDisconnect("LIMIT_EXCEEDED")).toBe(true);
    expect(refreshFailureIsDisconnect("SPAWN_FAILED")).toBe(true);
    expect(refreshFailureIsDisconnect("CONNECTION_FAILED")).toBe(true);
    expect(refreshFailureIsDisconnect(undefined)).toBe(true);
    expect(refreshFailureIsDisconnect("TARGET_BUSY")).toBe(false);

    const app = readFileSync(`${uiDirectory}/cli-app.ts`, "utf8");
    expect(app).toContain("refreshFailureIsDisconnect(code)");
    expect(app).toContain("stopActivityPolling()");
    expect(app).not.toMatch(/error\.code === "CONNECTION_FAILED"/);
  });

  it("records only verb metadata in Activity", () => {
    const app = readFileSync(`${uiDirectory}/cli-app.ts`, "utf8");
    expect(app).toContain("record.operation");
    expect(app).toContain("record.capabilityId");
    expect(app).toContain("record.exitCode");
    expect(app).toContain("record.durationMs");
    expect(app).toContain("record.outcome");
    expect(app).not.toContain("record.args");
    expect(app).not.toContain("record.env");
    expect(app).not.toContain("record.stdout");
    expect(app).not.toContain("record.stderr");
  });
});
