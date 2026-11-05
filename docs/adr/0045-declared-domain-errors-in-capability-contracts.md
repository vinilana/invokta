# ADR 0045: Declared domain errors in capability contracts

- Status: Accepted
- Date: 2026-11-05

## Context

ADR 0003 gave `EngineError` seven stable framework codes. They describe how the
invocation boundary failed, not which domain outcome a capability produced. A
capability could not declare a stable outcome such as `SLOT_CONFLICT` in its
contract, although an Appointment Scheduling Engine is expected to return
"either a confirmation or a stable conflict".

Authors had two workarounds. Modelling the failure inside the output union turns
a failed action into a successful result, so MCP `isError`, the CLI exit code,
and `invocation.failed` no longer report it. Throwing an `EngineError` with
`EXECUTION_FAILED` and ad-hoc `publicDetails` makes the outcome
indistinguishable from an unknown internal failure, and nothing in `describe`
tells a consumer that it exists. Neither gives a consumer a machine-readable hint
that the request may be retried.

AE-CTX-01 forbids an error factory in `ExecutionContext`. Consumers also rely on
`EngineErrorCode` being a closed union for exhaustive `switch` statements.

## Decision

### Declaration

A capability MAY declare `errors`, a record from a domain code to
`{ description, details?, retryable? }`. `createEngine` reads the field once with
the other top-level fields and validates it synchronously:

- a code matches `^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$`, has at most 64 characters,
  and is not a framework code, `DOMAIN_ERROR` included;
- a capability declares at most 64 domain errors;
- `description` is a non-empty string of at most 1,024 UTF-16 code units and
  becomes the public error message;
- `retryable` is an optional boolean that defaults to `false`; and
- `details` is an optional schema that satisfies Standard Schema v1 and
  Standard JSON Schema v1 and has an object root.

The map and each declaration must be ordinary records of data properties.
Proxies, custom prototypes, accessors, and unknown declaration fields fail
construction with `TypeError` without invoking an accessor. The runtime keeps a
frozen snapshot, so later mutation of the source map cannot change the contract.
An empty map is equivalent to no declaration.

### Raising

`@invokta/core` exports the standalone `CapabilityError` class. A handler raises
a declared outcome with
`throw new CapabilityError("SLOT_CONFLICT", { details, cause })`. Nothing is
added to `ExecutionContext`.

The optional type argument checks the arguments against a declaration map:
`new CapabilityError<typeof errors>(...)` accepts only declared codes, requires
details whose type is the input type of the declared schema, and rejects details
for a declaration without a schema. It is a union of per-code argument tuples,
not a capability-level generic, so `CapabilityDefinition` gains no type
parameter. Without the type argument any code compiles. Thrown values are
untyped in TypeScript and the type argument is not bound to the capability's
own `errors` field, so the runtime check below remains authoritative; authors
get the most from the types by declaring the map once as a constant and using
it for both the field and the type argument.

The constructor records its code and details in a module-private registry. The
engine reads only those constructor-time values, so replacing the instance
properties later cannot select another outcome. Look-alike objects, objects
created from the class prototype without the constructor, and proxies are not
recognized. As with `instanceof EngineError` today, a `CapabilityError` created
by a second installed copy of `@invokta/core` is not recognized and fails closed.

### Enforcement

Only a failure of `run` can become a domain error. When `run` rejects:

1. a value that is not a recognized `CapabilityError` keeps the existing
   normalization;
2. if the invocation signal is aborted, the existing cancellation precedence
   produces `CANCELLED`;
3. the code must be declared, and the details are validated and transformed by
   the declared schema, must be a lossless JSON object, and are snapshotted and
   frozen; without a details schema, details must be absent. Validation runs
   inside the capability timeout and the cancellation race, like output
   validation;
4. a valid outcome becomes an `EngineError` with code `DOMAIN_ERROR`, the
   declared description as its message, and the original `CapabilityError` as
   its internal `cause`; and
5. an undeclared code, missing or invalid details, or a failing validator becomes
   the generic `EXECUTION_FAILED` with the original `CapabilityError` as its
   internal `cause`.

A `CapabilityError` raised by an access rule or a schema validator is an unknown
failure. A thrown `EngineError` with code `DOMAIN_ERROR` is never preserved, even
when another invocation issued it: only the invocation that validated a domain
error against its own contract may publish it. A capability that forwards a
nested invocation's domain error therefore fails as `EXECUTION_FAILED` unless it
raises its own declared outcome.

### Public shape

The taxonomy gains exactly one framework code, `DOMAIN_ERROR`, and its
`publicDetails` has a documented shape:

```ts
interface DomainErrorPublicDetails {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
```

Widening `EngineErrorCode` to arbitrary strings would end exhaustive switches
and let a capability reuse or shadow framework semantics. Adding framework codes
such as `RATE_LIMITED` or `UNAVAILABLE` would move domain policy into the
framework; a retryable domain error expresses them. Carrying the domain outcome
in `publicDetails`, the only field AE-ERR-01 already lets adapters serialize,
means every adapter that serializes `publicDetails` transports it unchanged, and
the boundary rules for `cause`, stacks, and messages stay as they are. A consumer
adds one `case` and then branches on `publicDetails.code`.

### Description and adapters

`describe` adds `errors`, an array of `{ code, description, retryable,
detailsSchema? }` in declaration order, omitted when nothing is declared. The
details JSON Schema comes from the schema's output side, which describes the
value consumers receive. `list` is unchanged, and MCP tool definitions are
unchanged because an MCP tool has no error field.

The MCP adapter returns a domain error like every capability error: a tool
result with `isError: true` and one JSON text item containing `code`, `message`,
and `publicDetails`, without `structuredContent`, which would have to satisfy the
tool's output schema. The CLI writes the same compact JSON to standard error and
returns exit code `1`, as for every invocation failure. A distinct exit code is
not added: a domain outcome is still a failed invocation, and scripts branch on
the JSON code.

### Events

`invocation.failed` keeps `code` and adds `domainCode` only when the code is
`DOMAIN_ERROR`. A domain code is a bounded, validated contract identifier rather
than payload, so it can label metrics. Details are never part of an event, and
`retryable` is available from `describe`.

## Consequences

- A capability publishes its stable failure outcomes, their retry hints, and
  their details schemas as part of its contract, and every channel reports them
  identically through `engine.invoke`.
- This extends the ADR 0003 taxonomy from seven to eight codes. Adding a member
  to `EngineErrorCode` is a breaking change for exhaustive switches that assert
  `never`; they must handle `DOMAIN_ERROR`. Engines that declare no domain
  errors never produce it.
- Invalid domain outcomes fail closed, so a typo in a code or a details shape is
  visible as `EXECUTION_FAILED` in tests rather than leaking undeclared data.
- `retryable` is a hint for consumers. The framework still performs no automatic
  retry, backoff, or idempotency handling.
- Domain errors from access rules, framework-level retry metadata for other
  codes, and domain errors in MCP tool listings require separate decisions.
