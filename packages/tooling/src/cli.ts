#!/usr/bin/env node
import { checkCapabilities } from "./check-capabilities.js";

// The exit code is set rather than forced so buffered stderr writes flush.
process.exitCode = await checkCapabilities();
