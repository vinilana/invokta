#!/usr/bin/env node
import { runManagerCli } from "./run-manager-cli.js";

// The composition root owns process status so buffered output can flush.
process.exitCode = await runManagerCli();
