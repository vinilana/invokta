---
name: ai-engine-delivery
description: "Deliver AI Engine milestones and work items with TDD, adherence to versioned contracts and architecture, complete validation, and one cohesive commit per work item. Use when developing features, fixing bugs, executing roadmap milestones, or completing acceptance criteria in this repository."
---

# AI Engine Delivery

## Prepare the delivery

1. Read `docs/README.md` and locate the milestone in `docs/implementation-plan-and-acceptance-criteria.md`.
2. Compare the milestone with `docs/vision-and-invariants.md`, `docs/architecture.md`, `docs/v0.1-scope.md`, `docs/adr/README.md`, applicable ADRs, public contracts, and acceptance tests. Treat these versioned sources as authoritative; do not duplicate the specification in this skill.
3. Inspect the code, tests, and Git state before editing. Preserve unrelated changes and exclude unrelated files from the work item.
4. Define a small vertical slice: observable behavior, acceptance criterion, affected components, and validation command.

Stop and request a decision when authoritative documents conflict, acceptance criteria are not testable, or implementation requires expanding the contract or architecture.

## Apply the gates

### Gate 1 — Scope and contract

- Map each acceptance criterion to at least one observable test.
- Confirm inputs, outputs, errors, invariants, and limits before changing the implementation.
- Preserve public contract compatibility. Require an explicit decision for any breaking change.
- Apply `$ai-engine-contract-review` before coding when the milestone creates or changes an API, schema, port, event, public error, or operational limit.

### Gate 2 — RED

- Write the smallest test that demonstrates the missing behavior or bug first.
- Run the test and confirm that it fails for the expected reason, not because of an environment, fixture, or syntax error.
- Record the RED evidence in the delivery summary.

Do not proceed without a valid RED result unless the change is strictly documentation or tooling with no executable behavior. Explain the exception.

### Gate 3 — GREEN and REFACTOR

- Implement only what the test and contract require.
- Follow the dependency direction, ports, adapters, and boundaries defined by the ADRs.
- Avoid architectural shortcuts, global dependencies, validation bypasses, and premature abstractions.
- Run the focused test until it passes. Refactor without changing behavior, then run it again.

### Gate 4 — Validation

- Run the repository's documented canonical commands for focused tests, the full suite, static analysis, formatting, and builds.
- Add regression tests for contract errors, limits, and relevant edge cases.
- Inspect the final diff and demonstrate `acceptance criterion → test → implementation` traceability.
- Do not claim success while a required gate fails. Report external blockers with the exact command and error.

### Gate 5 — One commit per work item

- Include only the validated vertical slice and its tests in the commit.
- Review the staged diff and exclude generated artifacts, secrets, and unrelated changes.
- Create one cohesive commit after every gate passes. Describe the delivered behavior in the commit message.
- Start the next work item only after completing the current one. Do not rewrite or combine other authors' commits.

## Report the delivery

Include:

- the work item and satisfied criteria;
- added tests and RED/GREEN evidence;
- commands run and results;
- applied architectural decisions;
- the commit hash and message;
- risks, pending work, and skipped gates.
