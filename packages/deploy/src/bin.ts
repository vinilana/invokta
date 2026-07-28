#!/usr/bin/env node
import { runDeployCli } from "./cli.js";

// The composition root owns process status so buffered terminal output can flush.
process.exitCode = await runDeployCli();
