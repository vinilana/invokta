/**
 * Shared fixture material for the devtools tests.
 *
 * Every capability embeds `fixtureSecret` in its schemas and handler result so
 * a diagnostic that leaked a payload would be detectable by a substring
 * assertion.
 */

export const fixtureSecret = "devtools-fixture-secret-payload-marker";

export function schema() {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-devtools-fixture",
      validate: (value) => ({ value }),
      jsonSchema: {
        input: () => ({
          type: "object",
          description: `Fixture input guarded by ${fixtureSecret}.`,
        }),
        output: () => ({
          type: "object",
          description: `Fixture output guarded by ${fixtureSecret}.`,
        }),
      },
    },
  };
}
