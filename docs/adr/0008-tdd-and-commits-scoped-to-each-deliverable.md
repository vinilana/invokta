# ADR 0008: TDD and commits scoped to each deliverable

- Status: Accepted
- Date: 2026-07-27

## Context

The project defines contracts shared across three packages and multiple
transports. Large implementations without verifiable checkpoints make review,
regression analysis, and bisection difficult. Separating tests from the change
they specify also reduces the reliability of the history.

## Decision

Development will follow TDD for each observable deliverable:

1. record the expected behavior in a test that fails for the correct reason;
2. implement the smallest change that makes the test pass;
3. refactor while keeping the test suite green;
4. run the affected tests, typecheck, and lint before completing the deliverable.

Bug fixes will begin with a regression test. Public contracts will have contract
tests in the core and, when applicable, in the adapters. Test doubles may replace
ports, but the CLI, MCP, and HTTP paths will also have tests proving that they
converge on `invoke`.

Each completed deliverable will end in its own reviewable, green commit. The
commit will include together the test, implementation, and documentation required
for the same behavior; it will not mix in unrelated refactorings or features.
Subsequent deliverables will not be accumulated into the same commit. Changes
requested in review may be additional commits, provided they are focused and
green.

Broken intermediate commits may exist only locally during the red/green cycle;
they will not be presented as completed deliverables.

## Consequences

- Each implemented decision has executable evidence in the same slice of history.
- Review, reversion, and `git bisect` become more predictable.
- Cross-cutting changes must be divided into small vertical slices.
- Feedback time depends on fast, deterministic quality commands.
- Exceptions to the cycle or commit scope must be justified during review.
