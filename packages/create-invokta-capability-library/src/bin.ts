#!/usr/bin/env node
import { runCreateCapabilityLibraryCli } from "./cli.js";

// The composition root owns process status so buffered terminal output can flush.
process.exitCode = await runCreateCapabilityLibraryCli();
