# ADR 0015: Generated agent instruction aliases

- Status: Accepted
- Date: 2026-07-30

## Context

Invokta's engine and capability-library creators produce projects that require
the same architectural and delivery constraints after generation. Agent tools
commonly discover project instructions from either `AGENTS.md` or `CLAUDE.md`.
Generating two independent instruction files would create immediate drift risk,
while omitting either discovery name makes the starter less reliable across
tools.

The atomic capability creator remains a deliberately minimal package boundary.
The requested project-level instructions apply to generated Action Engines and
capability libraries, where composition and architectural constraints need to
remain visible during subsequent development.

## Decision

`create-invokta-engine` and `create-invokta-capability-library` each add two
root entries to their fixed starter:

```text
AGENTS.md
CLAUDE.md -> AGENTS.md
```

`AGENTS.md` is a deterministic UTF-8 text file with LF endings and one trailing
newline. It records the generated project's language, architecture or
capability-contract boundaries, test-first delivery workflow, package-manager
validation command, and the single-source instruction-file rule.

`CLAUDE.md` is an actual symbolic link whose stored target is exactly the
relative path `AGENTS.md`. It is not a copied file and does not use an absolute
target. The relative link keeps the generated project relocatable and gives
both discovery names one source of truth.

The creators treat text files and symbolic links as one ordered scaffold-entry
transaction. Both entry kinds use exclusive creation and never replace an
existing filesystem entry. An `EEXIST` race while creating the link reports
`SCAFFOLD_CONFLICT` for `CLAUDE.md` and preserves the racing entry. Any other
link-creation failure reports `WRITE_FAILED`. Rollback unlinks only entries
created by the current invocation; unlinking the symbolic link itself never
follows its target.

This decision extends the fixed path lists in ADR 0012 and the
capability-library section of ADR 0014. It does not change the atomic
`create-invokta-capability` scaffold.

Release verification must inspect the generated filesystem rather than merely
read through the alias: `AGENTS.md` must be a regular file, `CLAUDE.md` must be
a symbolic link, and its stored target must equal `AGENTS.md`.

## Consequences

- Generated engines and capability libraries expose consistent instructions to
  agent tools without maintaining duplicate content.
- The creator filesystem boundary now supports one fixed relative symbolic-link
  entry in addition to deterministic text files.
- Platforms or filesystems that cannot create symbolic links fail safely with
  `WRITE_FAILED`; the creators do not degrade to a copied instruction file.
- Existing generated projects are not changed in place because scaffold output
  remains user-owned after creation.
