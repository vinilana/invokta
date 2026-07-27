# AI Engine Framework v0.1

This documentation is the normative source for implementing version 0.1.0. The
framework allows a domain capability to be defined once and executed through a
direct call, the CLI, MCP stdio, and stateless MCP Streamable HTTP.

## Reading order

1. [Vision and invariants](./vision-and-invariants.md)
2. [Architecture and contracts](./architecture.md)
3. [v0.1 scope and limits](./v0.1-scope.md)
4. [Implementation plan and acceptance criteria](./implementation-plan-and-acceptance-criteria.md)
5. [Architecture decision records](./adr/README.md)

## Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **MAY**, and **OPTIONAL** indicate,
respectively, requirements, prohibitions, recommendations, and permitted
extensions. Requirements identified as `AE-<AREA>-NN` are tracked in the
acceptance matrix.

In the event of a conflict, the scope specification and the most recent ADRs take
precedence over examples. A change that expands the public API or the concepts in
v0.1 requires a real use case, a test, and an explicit architectural decision.

## Reference outcome

An engine must publish the same capability without duplicating business rules:

```text
my-engine list
my-engine describe support.classify-ticket
my-engine run support.classify-ticket --input '{"ticketId":"T-123"}'
my-engine-mcp --transport stdio
my-engine-mcp --transport http --port 3000
```
