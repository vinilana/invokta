/**
 * Application code that fails during module evaluation for a reason unrelated
 * to composition. It must be reported as an invalid-tooling exit, never as a
 * composition failure.
 */
throw new Error("Fixture module evaluation failed.");
