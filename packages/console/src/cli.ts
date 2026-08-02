#!/usr/bin/env node
import { runConsoleCli } from "./run-console-cli.js";

// The composition root owns process status so buffered output can flush.
process.exitCode = await runConsoleCli();
