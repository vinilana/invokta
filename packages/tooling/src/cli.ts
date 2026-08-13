#!/usr/bin/env node
import { checkCapabilities } from "./check-capabilities.js";
import { checkMcp } from "./check-mcp.js";

// The exit code is set rather than forced so buffered stderr writes flush.
process.exitCode =
  process.argv[2] === "check-mcp"
    ? await checkMcp()
    : await checkCapabilities();
