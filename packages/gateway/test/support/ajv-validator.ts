// The validator recipe documented in the package README and the docs-site
// reference, kept here so the documented code is executed by the tests.
import { Ajv, type ValidateFunction } from "ajv";

import type { JsonSchemaValidator } from "../../src/index.js";

const ajv = new Ajv({ strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

export const validator: JsonSchemaValidator = (schema, value) => {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    // An upstream schema with "$async": true compiles to a validator that
    // returns a promise, which is always truthy: refuse it.
    if ("$async" in validate) {
      throw new TypeError("Asynchronous schemas are not supported.");
    }
    compiled.set(schema, validate);
  }
  if (validate(value) === true) return undefined;
  return (validate.errors ?? []).map((error) => ({
    message: error.message ?? "Invalid value.",
    path: error.instancePath.split("/").slice(1),
  }));
};
