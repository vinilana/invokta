# ADR 0047: Schema-derived CLI flags and capability help

- Status: Accepted
- Date: 2026-11-05

## Context

ADR 0005 fixed `run` to exactly one input source, `--input <json>` or
`--stdin`, and left help to local handling. The `cli` starter profile is chosen
when people or local automation will run commands, yet a person had to write a
JSON object for every invocation and had no way to learn a capability's input
from the CLI other than reading the JSON Schema printed by `describe`.

Every capability already publishes a JSON Schema for its input through
`engine.describe`. Most local commands set a few top-level strings, numbers,
booleans, or enum values. The schema can therefore drive a small argument
grammar and a readable help page without a second contract, as long as the
capability's own validation remains the only authority on what input is valid.

## Decision

### Input sources

`run <capability-id>` accepts exactly one input source: `--input <json>`,
`--stdin`, or one or more schema-derived flags. Combining flags with `--input`
or `--stdin`, or using `--input` and `--stdin` together, is invalid usage. The
CLI does not merge sources, so no precedence rule exists. `run <capability-id>`
with no argument remains invalid usage; an empty input is `--input '{}'`.

`--input <json>` and `--stdin` keep their exact forms and behavior. They do not
read the capability description, so an unknown capability still reaches
`engine.invoke` exactly once. `--input=<json>` and `--stdin=<value>` are invalid
usage. This decision amends only the input-source rule of ADR 0005; its single
`engine.invoke` path, trusted principal, output, error, and exit-code rules are
unchanged.

### Flag table

A flag run reads `engine.describe(capabilityId).inputSchema` and derives flags
from its top-level `properties`, in schema order. A property is
flag-addressable when its schema is an object and one of the following holds:

- `type` is `string`, `number`, `integer`, or `boolean`, optionally with an
  `enum` or `const` whose values all match that type;
- `type` is absent and an `enum` or `const` holds only strings, only finite
  numbers, or only booleans, which then determine the type; or
- `type` is `array` without `prefixItems`, and `items` satisfies one of the
  rules above. The flag is repeatable.

Other keywords on an addressable property, such as `format`, `pattern`,
`minimum`, or `default`, do not change how a flag is decoded. Nested objects,
records, tuples, unions, `$ref`, type lists such as `["string", "null"]`, and
schemas without a decidable scalar type are input-only properties. A flag
cannot set them; `--input` or `--stdin` can. Unknown root keywords never add
flags.

A property name has a flag spelling only when it starts with an ASCII letter
and contains only ASCII letters, digits, `_`, and `-`. The spelling splits the
name before an uppercase letter that follows a lowercase letter or digit and
before an uppercase letter that starts a lowercase word after another uppercase
letter, treats `_` and `-` as separators, lowercases the words, and joins them
with `-`: `ticketId` and `ticket_id` become `--ticket-id`, and `HTTPServer`
becomes `--http-server`. A spelling longer than 64 characters is not used.

`input`, `stdin`, `help`, and `format` are reserved CLI option names. A
property whose spelling equals one of them is input-only. `format` is reserved
for host-selected output formatting, so a later CLI option cannot change the
meaning of an existing capability flag.

A boolean property claims its spelling and `no-<spelling>`; every other
mappable property claims its spelling. When two or more properties claim the
same spelling, every one of them becomes input-only. A collision never selects
a winner by order or case.

### Values

- `--name value` and `--name=value` set a string, number, or integer flag. In
  the space-separated form the next argument is the value unless it starts with
  `--`; a value that starts with `--` uses `--name=--value`.
- A boolean flag never consumes the next argument. `--flag` and `--flag=true`
  set `true`; `--no-flag` and `--flag=false` set `false`. Any other inline
  value, or a value on `--no-flag`, is invalid usage.
- A repeatable flag appends each occurrence in argument order. Flags cannot
  produce an empty array.
- A non-repeatable property set more than once, including `--flag` together
  with `--no-flag`, is invalid usage.
- Strings are used verbatim. Numbers and integers must match the JSON number
  grammar and decode exactly as `JSON.parse` would; numbers must be finite, and
  integers must be safe integers.

The flags build one plain JSON object, keyed by the original property names in
schema order. The CLI does not check required properties, apply or invent
defaults, check enum membership, or apply any other constraint. That object
goes through `engine.invoke` like every other input, so the schema's validation
and transforms remain authoritative and an invalid object fails with
`INPUT_INVALID` and exit code `1`.

### Errors

An unknown flag, a positional argument, a reserved option in a flag run, a
value that does not decode as the declared type, a missing value, a duplicate,
and a flag for an input-only property are `INVALID_USAGE` with exit code `2`
and do not call `engine.invoke`. A diagnostic for an input-only property names
the property and the reason, and says to use `--input` or `--stdin`. Argument
structure errors include the usage text; value errors do not. Diagnostics never
echo flag values or positional arguments. An unknown flag name is echoed only
when it is at most 64 ASCII letters, digits, `_`, and `-`.

A flag run against an unknown capability fails while reading its description,
with the same `CAPABILITY_NOT_FOUND` error and exit code `1` that
`engine.invoke` would produce. Because `engine.invoke` is not reached, no
invocation event is emitted for that failure.

Flags populate business input only. The principal still comes only from the
composition root; a property named `actor`, `role`, or `user` is business input
exactly as it is through `--input`, and the CLI still has no actor, role, or
login option.

### Help

`help` and `--help` print the general usage. `help <capability-id>` and
`run <capability-id> --help` print one capability page. `--help` in a run must
be the only argument after the capability ID. Help is written to stdout as
plain text with exit code `0`, is not affected by the trusted `format` option,
and never invokes a capability. An unknown capability on a help page is the
`CAPABILITY_NOT_FOUND` error with exit code `1`. Other invalid help usage keeps
exit code `2`.

The capability page lists the ID, title, description, declared annotations,
the run forms including `--input` and `--stdin`, each flag with its type,
`required` and `repeatable` markers, description, allowed `enum` or `const`
values, and declared default, followed by the input-only properties and their
reasons. The page is deterministic for a given description. It lists at most
100 flag and input-only entries, at most 20 allowed values per flag, and at
most 500 characters per text field. Whitespace, C0 and C1 control characters,
and bidirectional formatting characters in author text collapse to one space.

### Out of scope

Shell completion is not provided. A completion script would need either a
per-shell generator or a hidden completion protocol, and a schema-aware one
would load the engine on every key press. Neither is trivial to keep
deterministic and bounded, so completion remains a possible later decision.
Short options, nested-object flags such as `--address.city`, flag-based empty
arrays or `null`, merging flags into `--input`, and environment-variable input
are also not provided.

The devtools CLI workbench keeps using only the published verbs and `--input`
(AE-LIMIT-07); it does not pass schema-derived flags.

## Consequences

- A capability with simple top-level input can be run as
  `engine run onboarding.create-welcome-message --name Ada` without writing
  JSON, and `engine help <capability-id>` explains its flags.
- Validation, authorization, events, and error normalization still happen only
  in `engine.invoke`; the adapter decodes strings into JSON types and reads the
  same published contract that MCP and `describe` expose.
- Renaming, retyping, or adding a top-level property, or introducing a
  collision with an existing spelling, changes the flags a capability accepts.
  Capability authors treat top-level property names as part of the CLI surface
  when they publish the CLI channel.
- Existing `--input` and `--stdin` invocations, their output, and their exit
  codes are unchanged. The usage text embedded in `INVALID_USAGE` messages
  lists the new forms.
- Error ordering differs by source: a flag run reports an unknown capability
  before invocation, while `--input` and `--stdin` report it from
  `engine.invoke`.
