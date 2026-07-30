#!/usr/bin/env node
import { runCreateEngineCli } from "./cli.js";

// The composition root owns process status so buffered terminal output can flush.
process.exitCode = await runCreateEngineCli();
