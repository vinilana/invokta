/**
 * Shared fixture material for the `check-capabilities` tests.
 *
 * The checker never validates capability shape, so these fixtures stay free of
 * schema dependencies while still carrying realistic payload material. Every
 * capability embeds `fixtureSecret` in its description, schemas, dependency
 * values, and handler result so a diagnostic that leaked a payload would be
 * detectable by a substring assertion.
 */

export const fixtureSecret = "fixture-secret-payload-marker";

function schema() {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-tooling-fixture",
      validate: (value) => ({ value }),
    },
    marker: fixtureSecret,
  };
}

export function capability() {
  return {
    title: `Fixture capability (${fixtureSecret})`,
    description: `Fixture capability guarded by ${fixtureSecret}.`,
    input: schema(),
    output: schema(),
    access: "public",
    dependencies: { apiKey: fixtureSecret },
    async run() {
      return { marker: fixtureSecret };
    },
  };
}
