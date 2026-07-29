---
name: invokta-contract-review
description: "Review Invokta contracts for public APIs, acceptance criteria, errors, invariants, operational limits, compatibility, and architectural boundaries. Use before implementing or approving changes to interfaces, schemas, ports, events, observable persistence, configuration, or public behavior in this repository."
---

# Invokta Contract Review

## Establish the source of truth

1. Read `docs/README.md` and `docs/vision-and-invariants.md`.
2. Compare the change with `docs/architecture.md`, `docs/v0.1-scope.md`, `docs/implementation-plan-and-acceptance-criteria.md`, `docs/adr/README.md`, and applicable ADRs.
3. Inspect public types, acceptance tests, and the existing implementation. Do not infer guarantees from examples or internal details.
4. Identify the consumer, public surface, and change type: additive, compatible, ambiguous, or breaking.
5. Stay read-only for review requests. Edit only when the user requests fixes.

## Apply the gates

### Gate 1 — Complete surface

Inventory each applicable concern:

- operations, inputs, outputs, and observable effects;
- public errors, codes, stable messages, and retry policy;
- defaults, configuration, ordering, and determinism;
- timeouts, cancellation, concurrency, and idempotency;
- size, count, depth, time, and resource limits;
- versioning, migration, and backward compatibility;
- responsible ports and ADR-authorized adapters.

Mark missing details as `unspecified`; do not fill gaps with assumptions.

### Gate 2 — Executable acceptance

- Rewrite vague requirements as binary, observable outcomes.
- Map `requirement → contract → acceptance test → evidence`.
- Require happy paths, expected errors, and inclusive and exclusive boundary cases.
- Reject criteria based only on internal structure, subjective adjectives, or undefined future implementation.

### Gate 3 — Limits and failures

- Verify validation at the correct boundary and consistent behavior across adapters.
- Require safe, deterministic failure for invalid input, limit violations, unavailability, and cancellation.
- Find unbounded resources, duplicate work, uncontrolled growth, and external dependencies without timeouts.
- Confirm that logs, metrics, and errors expose no secrets or sensitive content.

### Gate 4 — Architecture and evolution

- Confirm dependency direction and each port and adapter responsibility against the ADRs.
- Flag framework, transport, or persistence types that leak into the domain.
- Separate intentional contracts from implementation details. Prevent public tests from freezing internal details.
- Classify compatibility breaks and require an explicit decision, version, or migration.

### Gate 5 — Verdict

Return `APPROVED` only when contracts, acceptance criteria, and limits are complete, testable, and consistent with the ADRs. Return `APPROVED WITH CONDITIONS` only for non-blocking risks with concrete actions. Return `BLOCKED` for material ambiguity, unauthorized breaking changes, missing critical limits, or architectural violations.

## Report the review

Present findings first, ordered by severity, with `file:line` evidence. Then include:

- a compact traceability matrix;
- gaps marked as `unspecified`;
- compatibility impact;
- questions requiring decisions;
- the verdict and pending gates.

Do not report that no issues exist without listing the surfaces and limits checked.
