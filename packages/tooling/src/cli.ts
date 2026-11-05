#!/usr/bin/env node
import { checkCapabilities } from "./check-capabilities.js";
import { checkMcp } from "./check-mcp.js";
import { runContractCommand } from "./contract.js";

const command = process.argv[2];

// The exit code is set rather than forced so buffered stderr writes flush.
process.exitCode =
  command === "check-mcp"
    ? await checkMcp()
    : command === "contract"
      ? await runContractCommand()
      : await checkCapabilities();
