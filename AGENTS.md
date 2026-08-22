# Repository Instructions

## Language

Write all repository content in English, including documentation, ADRs, skills,
source comments, public error messages, examples, tests, commit messages, and
release notes.

## Delivery workflow

- Read `CONTRIBUTING.md` for repository setup, branch preparation, focused
  validation, agent-team coordination, and pull-request evidence.
- Read `docs/README.md` and the applicable ADRs before changing a public contract.
- Follow RED, GREEN, REFACTOR for executable behavior.
- Keep one validated, cohesive commit per deliverable.
- Preserve the documented scope limits; do not add speculative abstractions.
- Keep CLI and MCP adapters on the single `engine.invoke` execution path.
- In a shared worktree, assign non-overlapping write ownership and preserve
  changes made by other contributors or agents.
