#!/usr/bin/env node
import { runInstallerCli } from "./run-installer-cli.js";

// The composition root owns process status so buffered terminal output can flush.
process.exitCode = await runInstallerCli();
