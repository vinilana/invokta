# Review engine example

This example publishes `review.assess-task-readiness`, a fail-closed completion
gate for coding agents. The agent submits the task, acceptance criteria, changed
files, patch, and verification evidence. The capability runs three independent
reviews and returns `readyToComplete: true` only when every gate passes.

The same capability is available through direct invocation, the CLI, MCP stdio,
and stateless MCP HTTP. Every channel executes the capability through
`engine.invoke`; no adapter duplicates the review rules.

## Standard agent workflow

1. Turn the task requirements into binary, observable acceptance criteria with
   stable IDs.
2. Implement the change and collect evidence. Every evidence record names the
   criteria it supports and records whether the check passed.
3. Submit the current changed-file list and patch to
   `review.assess-task-readiness`.
4. Address every returned blocker, update the patch and evidence, and run the
   assessment again.
5. Declare the task complete only when `readyToComplete` is `true`, `blockers` is
   empty, and `nextAction` is `declare-complete`.

An assessment is stateless and describes one review attempt. Rerunning after a
change creates a fresh decision from the new candidate; the framework does not
provide a workflow engine, review session, queue, or release gate.

## Review policy

The versioned policy lives in `src/domain/policy.ts`. Review adapters receive the
applicable rule set and independent snapshots of the candidate, so one reviewer
cannot mutate another reviewer's input or anchor it with a prior verdict.

### Code review

| Rule | Required review behavior |
| --- | --- |
| `CR-01` | Find correctness defects and regressions relative to the task and acceptance criteria. |
| `CR-02` | Check public contracts, compatibility, architecture boundaries, and repository instructions. |
| `CR-03` | Require focused verification and reject known failing checks. |
| `CR-04` | Inspect relevant security, authorization, data handling, cancellation, concurrency, and resource limits. |
| `CR-05` | Reject unrelated scope, unresolved bypasses, speculative abstractions, and maintainability regressions. |

A `blocker` or `major` finding fails the code-review gate. A `minor` finding is
reported but does not prevent completion. Duplicate finding IDs and findings
that cite an unknown rule fail closed.

### Acceptance judges and evals

| Rule | Required evaluation behavior |
| --- | --- |
| `EV-01` | Return exactly one binary verdict for every criterion and none for unknown criteria. |
| `EV-02` | A pass cites unique, passed evidence mapped to that same criterion. |
| `EV-03` | Judge observable outcomes instead of implementation details or confidence claims. |
| `EV-04` | Missing, conflicting, ambiguous, or unreproducible evidence fails closed. |

The engine, rather than the judge, enforces criterion coverage and evidence
cross-references. A persuasive but structurally incomplete judge response can
never produce a passing completion decision.

### Adversarial review

| Rule | Required adversarial behavior |
| --- | --- |
| `AR-01` | Attempt at least one concrete counterexample for every criterion. |
| `AR-02` | Probe applicable invalid inputs, boundaries, failures, authorization, cancellation, and concurrency. |
| `AR-03` | Challenge the candidate independently of prior review and eval claims. |
| `AR-04` | Every exposed gap or missing criterion challenge blocks completion. |

An adversarial attempt reports either `survived` or `exposed-gap`. An unknown
criterion, duplicate attempt ID, exposed gap, or criterion without an attempt
fails the adversarial gate.

## Deterministic demonstration adapter

`src/infrastructure/deterministic-reviewers.ts` keeps the example runnable with
no model provider. It checks structured evidence, requires at least one passing
automated test, requires passing `adversarial-test` evidence for every criterion,
rejects reported failing checks, and flags added `TODO`, `FIXME`, `@ts-ignore`,
or `biome-ignore` markers.

Those checks demonstrate the contract and workflow; they are not a production
code reviewer, LLM judge, security scanner, or quality guarantee. Replace the
three ports in `src/application/ports.ts` with model-, tool-, or service-backed
adapters that apply the supplied rules, bound provider responses, and honor the
received `AbortSignal`. The readiness calculation and public capability contract
do not change.

## Contract and limits

- An authenticated principal is required and comes from the invocation boundary,
  never from the task payload.
- Each request contains 1–50 unique criteria, 1–200 evidence records, and 1–200
  changed files.
- The patch is limited to 200,000 characters. Identifiers are limited to 96
  characters; summaries, commands, file names, and rule outputs also have
  explicit schema limits.
- Evidence IDs are unique and may reference only criteria declared by the same
  request.
- Reviewer reports are bounded before readiness is calculated: 200 code
  findings, 100 eval results, and 200 adversarial attempts.
- The capability timeout is 120 seconds. Cancellation is propagated to all
  three reviewer ports.
- Invalid input fails as `INPUT_INVALID`; unauthorized calls fail before any
  reviewer runs; reviewer failures are normalized by the engine pipeline.
- The patch and evidence are business payloads and are not included in framework
  events. Provider-backed adapters must apply their own data-handling policy,
  and reviewer summaries and findings must not expose secrets because they are
  returned to the caller.

## Run the example

From the repository root, build the framework and example:

```sh
yarn build
```

Run the bundled passing assessment:

```sh
node examples/review-engine/dist/direct.js
```

Use the CLI:

```sh
node examples/review-engine/dist/cli.js list
node examples/review-engine/dist/cli.js describe review.assess-task-readiness
node examples/review-engine/dist/cli.js run review.assess-task-readiness --input '{"taskId":"TASK-1","summary":"Verify completion","acceptanceCriteria":[{"id":"AC-1","statement":"The focused test passes."}],"change":{"summary":"Add the behavior","files":["src/change.ts","test/change.test.ts"],"patch":"+export const changed = true;"},"evidence":[{"id":"TEST-1","kind":"test","criterionIds":["AC-1"],"passed":true,"command":"vitest run change.test.ts","summary":"Focused test passed."},{"id":"ADV-1","kind":"adversarial-test","criterionIds":["AC-1"],"passed":true,"command":"vitest run change.adversarial.test.ts","summary":"The negative case stayed blocked."}]}'
```

Start the MCP stdio adapter from an MCP host configuration:

```sh
node examples/review-engine/dist/mcp-stdio.js
```

Start stateless MCP HTTP on the loopback default:

```sh
REVIEW_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/review-engine/dist/mcp-http.js
```

The literal bearer-token comparison is a deterministic authentication-boundary
demonstration, not production identity validation.

## Verify the example

```sh
yarn workspace @invokta/example-review test
yarn workspace @invokta/example-review typecheck
yarn workspace @invokta/example-review build
```
