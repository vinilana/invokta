---
name: add-invokta-capability
description: Add or change domain capabilities in this Invokta Action Engine with explicit contracts, authenticated access, engine-owned dependencies, migrations, and tests. Use when a user asks to add an action, tool, capability, domain behavior, repository operation, schema, or capability ID, or to expose behavior consistently through direct, CLI, MCP stdio, and MCP HTTP channels.
---

# Add an Invokta Capability

Resolve the project root as three directories above this `SKILL.md`. Perform
all relative reads and commands from that root; do not assume the caller's
current working directory is the project.

## Establish the contract

1. Read `AGENTS.md`, `CUSTOMIZE.md`, `src/engine.ts`,
   `src/capabilities/template.ts`, and `test/engine.test.ts` completely.
2. Define the stable capability ID, title, description, input, output, access,
   timeout, annotations, dependency failures, and observable errors.
3. Ask for an explicit decision before changing an existing ID, schema, access
   rule, or output contract.

## Follow RED, GREEN, REFACTOR

1. Add an engine-level test that invokes the literal capability ID through
   `engine.invoke` and fails for the missing behavior.
2. Cover unauthenticated access and invalid input. Cover ownership, not-found,
   cancellation, or dependency failure when the capability can encounter it.
3. Implement the smallest capability and dependency boundary that passes.
4. Refactor only after the contract is executable.

## Keep one engine boundary

- Define the action with `defineCapability` and Zod input/output schemas.
- Use `access: "authenticated"` for user or tenant data unless the user
  explicitly approves a public contract.
- Treat `context.principal.id` as the ownership boundary for per-user data.
- Inject repositories, providers, clocks, and tools through engine-owned
  factories or closures.
- Register the literal ID in `src/engine.ts` and `invokta.mcp.json`.
- Keep business logic out of `src/direct.ts`, `src/cli.ts`, `src/mcp-stdio.ts`,
  and `src/mcp-http.ts`.
- Never call a capability's `run` method directly.

## Add persistence safely

- Start domain migrations after `migrations/001_oauth.sql`.
- Use `002_domain.sql` for the first domain migration; inspect the existing
  migration list before choosing every later number.
- Make migrations transactional and safe to rerun.
- Add each migration filename to `src/database/migrate.ts`.
- Keep every per-user query constrained by the authenticated principal.
- Do not couple domain tables to `oauth_artifacts`; OAuth persistence is an
  authorization-server implementation detail.
- Extend the structure that exists in the project. Do not invent repository,
  domain, schema, or test files before confirming they are present or needed.

## Deliver

1. Update `README.md`, `CUSTOMIZE.md`, or domain documentation when public
   behavior or configuration changes.
2. Run `npm run check`.
3. Validate both Compose files when configuration changes.
4. Report the capability ID, access contract, tests, and any migration or
   deployment requirement.
