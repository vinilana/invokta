import { EngineError, type EngineErrorCode } from "./error.js";
import { isProxy } from "./host-types.js";
import {
  type EngineJsonSchema,
  type EngineSchema,
  type InferSchemaInput,
  readJsonSchema,
  snapshotLosslessJson,
  validateSchema,
} from "./schema.js";

/** One stable domain outcome that a capability may raise from `run`. */
export interface CapabilityErrorDeclaration {
  readonly description: string;
  readonly details?: EngineSchema;
  readonly retryable?: boolean;
}

/** Domain error declarations keyed by their UPPER_SNAKE_CASE domain code. */
export type CapabilityErrorMap = Readonly<
  Record<string, CapabilityErrorDeclaration>
>;

/** A declared domain error as published by `engine.describe`. */
export interface CapabilityErrorDescription {
  readonly code: string;
  readonly description: string;
  readonly retryable: boolean;
  readonly detailsSchema?: EngineJsonSchema;
}

/** The `publicDetails` of an `EngineError` whose code is `DOMAIN_ERROR`. */
export interface DomainErrorPublicDetails {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

type DeclaredErrorArguments<Declaration extends CapabilityErrorDeclaration> =
  Declaration extends {
    readonly details: infer Schema extends EngineSchema;
  }
    ? [
        options: {
          readonly details: InferSchemaInput<Schema>;
          readonly cause?: unknown;
        },
      ]
    : [options?: { readonly details?: undefined; readonly cause?: unknown }];

/**
 * Constructor arguments for `CapabilityError`. A concrete declaration map
 * restricts the code to its declared keys, optionally narrowed by `Code`, and
 * the details to the input type of the matching details schema; the default map
 * accepts any code and details.
 */
export type CapabilityErrorArguments<
  Errors extends CapabilityErrorMap,
  Code extends Extract<keyof Errors, string> = Extract<keyof Errors, string>,
> = string extends keyof Errors
  ? [
      code: Code,
      options?: { readonly details?: unknown; readonly cause?: unknown },
    ]
  : {
      [Declared in Code]: [
        code: Declared,
        ...DeclaredErrorArguments<Errors[Declared]>,
      ];
    }[Code];

interface RaisedCapabilityError {
  readonly code: unknown;
  readonly details: unknown;
}

const raisedCapabilityErrors = new WeakMap<object, RaisedCapabilityError>();

/**
 * Raises a declared domain error from a capability's `run`. The engine checks
 * the code and details against the capability's `errors` declaration and
 * publishes a `DOMAIN_ERROR`; anything else fails closed as `EXECUTION_FAILED`.
 */
export class CapabilityError<
  Errors extends CapabilityErrorMap = CapabilityErrorMap,
  // `code` uses only this parameter, so a typed error stays assignable to the
  // plain `CapabilityError` type.
  Code extends Extract<keyof Errors, string> = Extract<keyof Errors, string>,
> extends Error {
  readonly code: Code;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(...args: CapabilityErrorArguments<Errors, Code>) {
    const [code, options] = args as unknown as readonly [
      Code,
      { readonly details?: unknown; readonly cause?: unknown }?,
    ];
    const details = options?.details;
    const cause = options?.cause;
    super(
      "A capability raised a domain error.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "CapabilityError";
    this.code = code;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
    // The engine reads these constructor-time values, never the mutable
    // instance properties, so later property changes cannot select an outcome.
    raisedCapabilityErrors.set(this, Object.freeze({ code, details }));
  }
}

const maximumDeclaredErrors = 64;
const maximumCodeLength = 64;
const maximumDescriptionLength = 1024;
const domainCodePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const declarationFields = new Set(["description", "details", "retryable"]);
const frameworkCodes = new Set<string>([
  "CAPABILITY_NOT_FOUND",
  "INPUT_INVALID",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "OUTPUT_INVALID",
  "CANCELLED",
  "EXECUTION_FAILED",
  "DOMAIN_ERROR",
] satisfies EngineErrorCode[]);

interface DeclaredError {
  readonly description: string;
  readonly retryable: boolean;
  readonly details?: EngineSchema;
}

type DeclaredErrors = Readonly<Record<string, DeclaredError>>;

function isPlainRecord(value: unknown): value is object {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError("Declarations must use data properties.");
  }
  return descriptor.value;
}

function snapshotDeclaration(value: unknown): DeclaredError {
  if (!isPlainRecord(value)) {
    throw new TypeError("A declaration must be a record.");
  }
  for (const field of Object.keys(value)) {
    if (!declarationFields.has(field)) {
      throw new TypeError("A declaration contains an unknown field.");
    }
  }
  const description = readOwnData(value, "description");
  const details = readOwnData(value, "details");
  const retryable = readOwnData(value, "retryable");
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > maximumDescriptionLength
  ) {
    throw new TypeError("A declaration description is invalid.");
  }
  if (retryable !== undefined && typeof retryable !== "boolean") {
    throw new TypeError("A declaration retryable flag is invalid.");
  }
  if (
    details !== undefined &&
    ((typeof details !== "object" && typeof details !== "function") ||
      details === null)
  ) {
    throw new TypeError("A declaration details schema is invalid.");
  }
  return Object.freeze({
    description,
    retryable: retryable === true,
    ...(details === undefined ? {} : { details: details as EngineSchema }),
  });
}

/**
 * Validates and snapshots a capability's `errors` field during engine
 * construction. Returns `undefined` when no domain error is declared.
 */
export function snapshotDeclaredErrors(
  capabilityId: string,
  value: unknown,
): CapabilityErrorMap | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(
      `Capability ${capabilityId} errors must be a record of domain error declarations.`,
    );
  }
  const codes = Object.keys(value);
  if (codes.length > maximumDeclaredErrors) {
    throw new TypeError(
      `Capability ${capabilityId} declares more than ${maximumDeclaredErrors} domain errors.`,
    );
  }
  if (codes.length === 0) return undefined;
  const snapshot: Record<string, DeclaredError> = Object.create(null);
  for (const code of codes) {
    if (code.length > maximumCodeLength || !domainCodePattern.test(code)) {
      throw new TypeError(
        `Capability ${capabilityId} declares an invalid domain error code.`,
      );
    }
    if (frameworkCodes.has(code)) {
      throw new TypeError(
        `Capability ${capabilityId} domain error ${code} reuses a framework error code.`,
      );
    }
    try {
      snapshot[code] = snapshotDeclaration(readOwnData(value, code));
    } catch (cause) {
      throw new TypeError(
        `Capability ${capabilityId} domain error ${code} has an invalid declaration.`,
        { cause },
      );
    }
  }
  return Object.freeze(snapshot);
}

/** Produces the `describe` entries for a snapshotted declaration map. */
export function describeDeclaredErrors(
  capabilityId: string,
  errors: CapabilityErrorMap | undefined,
): ReadonlyArray<CapabilityErrorDescription> | undefined {
  if (errors === undefined) return undefined;
  const declared = errors as DeclaredErrors;
  return Object.keys(declared).map((code) => {
    const declaration = declared[code] as DeclaredError;
    let detailsSchema: EngineJsonSchema | undefined;
    if (declaration.details !== undefined) {
      try {
        detailsSchema = readJsonSchema(declaration.details, "output");
      } catch (cause) {
        throw new TypeError(
          `Capability ${capabilityId} domain error ${code} could not produce its details JSON Schema.`,
          { cause },
        );
      }
      if (detailsSchema.type !== "object") {
        throw new TypeError(
          `Capability ${capabilityId} domain error ${code} details schema must have an object root.`,
        );
      }
    }
    return {
      code,
      description: declaration.description,
      retryable: declaration.retryable,
      ...(detailsSchema === undefined ? {} : { detailsSchema }),
    };
  });
}

/**
 * Recognizes only errors created by this module's `CapabilityError`. The
 * identity lookup never invokes a proxy trap or a property accessor.
 */
export function isRaisedCapabilityError(value: unknown): boolean {
  return raisedCapabilityErrors.has(value as object);
}

/**
 * Resolves a raised `CapabilityError` against the capability's snapshotted
 * declarations. Returns the public `DOMAIN_ERROR`, or `undefined` when the
 * code is undeclared or the details do not satisfy the declared schema.
 */
export async function resolveDomainError(
  errors: CapabilityErrorMap | undefined,
  failure: unknown,
): Promise<EngineError | undefined> {
  const raised = raisedCapabilityErrors.get(failure as object);
  if (errors === undefined || raised === undefined) return undefined;
  const code = raised.code;
  if (typeof code !== "string" || !Object.hasOwn(errors, code)) {
    return undefined;
  }
  const declaration = (errors as DeclaredErrors)[code] as DeclaredError;
  let details: Readonly<Record<string, unknown>> | undefined;
  if (declaration.details === undefined) {
    if (raised.details !== undefined) return undefined;
  } else {
    let validated: unknown;
    try {
      validated = await validateSchema(declaration.details, raised.details, {
        code: "OUTPUT_INVALID",
        message: "Domain error details validation failed.",
      });
    } catch {
      return undefined;
    }
    if (
      typeof validated !== "object" ||
      validated === null ||
      Array.isArray(validated)
    ) {
      return undefined;
    }
    details = snapshotLosslessJson(validated as Record<string, unknown>);
  }
  const publicDetails: DomainErrorPublicDetails = Object.freeze({
    code,
    retryable: declaration.retryable,
    ...(details === undefined ? {} : { details }),
  });
  return new EngineError({
    code: "DOMAIN_ERROR",
    message: declaration.description,
    publicDetails,
    cause: failure,
  });
}
