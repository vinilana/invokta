#!/usr/bin/env node
import { runDevtoolsCli } from "./run-devtools-cli.js";

// The exit code is set rather than forced so buffered stderr writes flush.
process.exitCode = await runDevtoolsCli();
