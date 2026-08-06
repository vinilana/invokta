/**
 * Application code that fails during module evaluation. It must be reported as
 * an unusable build input, never as a doctor finding.
 */
throw new Error("Fixture module evaluation failed.");
