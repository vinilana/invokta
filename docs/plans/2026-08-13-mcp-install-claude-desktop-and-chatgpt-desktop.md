# Plan: MCP install support for Claude Desktop (work and code) and ChatGPT Desktop (Codex and work)

- Status: Proposed
- Date: 2026-08-13
- Scope: `@invokta/installer`, installer reference documentation, one new ADR
- Related: [ADR 0013](../adr/0013-action-engine-mcp-installation-and-management.md),
  [ADR 0017](../adr/0017-engine-scoped-mcp-uninstall.md),
  [ADR 0022](../adr/0022-mcp-installation-inspection-and-homologation.md),
  [installer reference](../../apps/docs/src/content/docs/reference/installer.mdx)

## 1. Goal

Let `mcp:install` (and the underlying `@invokta/installer` sessions) cover the
four requested product surfaces:

1. **Claude Desktop — work surface** (Chat and Cowork in the desktop app)
2. **Claude Desktop — code surface** (the Code tab in the desktop app)
3. **ChatGPT Desktop — Codex surface** (the Codex agent inside the ChatGPT app)
4. **ChatGPT Desktop — work surface** (the ChatGPT chat/connector surface)

The plan preserves the installer's durable boundaries from ADR 0013: no network
access, no process execution, no credential values on disk, user-scope
configuration only, and mutation restricted to platforms with the no-follow
ownership and atomic-write contract (macOS and Linux; Windows mutation stays
out of scope).

## 2. Verified facts driving the design

These were verified on 2026-08-13 against official documentation
(code.claude.com, developers.openai.com, help/support articles, and the
`openai/codex` source).

### Claude Desktop (work and code)

- `claude_desktop_config.json` is the official, file-based, stdio-only MCP
  configuration for the desktop app. Paths: macOS
  `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux
  `~/.config/Claude/claude_desktop_config.json`; Windows
  `%APPDATA%\Claude\claude_desktop_config.json`. Entries with a `url` field are
  not supported in this file and are known to corrupt it
  (anthropics/claude-code issue #37286) — the existing
  `claude-desktop-http-config-unsupported` compatibility gate is correct and
  must stay.
- Anthropic shipped an official **Linux beta of Claude Desktop on
  2026-06-30** (Ubuntu 22.04+/Debian 12+, amd64 and arm64), documented at
  code.claude.com/docs/en/desktop-linux with "the same Chat, Cowork, and
  Claude Code experience as on macOS and Windows". The installer's
  `claude-desktop` target is currently hard-blocked off macOS.
- The desktop app **bridges `claude_desktop_config.json` into both the work
  surface and the Code tab**: per code.claude.com/docs/en/desktop, servers in
  that file are available in the chat surface and in local Code-tab sessions,
  alongside servers from `~/.claude.json` and `.mcp.json`. On a duplicate
  server name, the Code tab prefers the `claude_desktop_config.json`
  definition; at the top level of `~/.claude.json` versus `.mcp.json`, the
  Code tab prefers `~/.claude.json`.
- Cowork consumes the same file (bridged into the Cowork VM) plus
  account-level connectors; it has no separate documented config file.
- The Claude Code CLI does **not** read `claude_desktop_config.json`; the
  existing `claude-code` target (`~/.claude.json`, honoring
  `CLAUDE_CONFIG_DIR`) already covers the CLI and, through shared files, the
  desktop Code tab.
- Remote (HTTP) servers reach Claude Desktop only through account-level
  Connectors added in the app UI — there is no local file an installer may
  write for them.

### ChatGPT Desktop (Codex and work)

- **Codex** (CLI, IDE extension, and the Codex surface inside the ChatGPT
  desktop app) reads one configuration home: `$CODEX_HOME/config.toml`,
  defaulting to `~/.codex/config.toml`. Official Codex docs state the app
  surfaces inherit the same configuration as the IDE extension and CLI.
  Writing that file therefore **already reaches Codex inside ChatGPT
  Desktop** — the installer's existing `codex` target is the correct and only
  file-writable path into the OpenAI desktop ecosystem.
- The `[mcp_servers]` TOML schema the installer writes today (`command`,
  `args`, `env_vars`, `enabled`, `url`, `bearer_token_env_var`,
  `env_http_headers`) remains valid in current Codex. The historical
  `experimental_use_rmcp_client` flag was removed in openai/codex PR #8087
  (2025-12-20); native Streamable HTTP is the default. No schema migration is
  required.
- The **ChatGPT work surface** (chat, connectors, Apps SDK apps) supports MCP
  **only as remote servers over HTTPS (Streamable HTTP or SSE)**, added
  through the account-level developer-mode UI (Settings → Apps & Connectors).
  Connectors are stored server-side and synced across clients. **Local stdio
  servers are not supported, and there is no local configuration file** on any
  OS that an installer could write.

## 3. Gap analysis

| Requested surface | Current state | Gap |
| --- | --- | --- |
| Claude Desktop work | `claude-desktop` target exists, macOS-only, stdio-only | No Linux support; work/Cowork coverage undocumented |
| Claude Desktop code | Covered indirectly by `claude-code` (`~/.claude.json`) and by `claude-desktop` bridging | Coverage and duplicate-name precedence undocumented; surface naming does not tell the user the Code tab is reached |
| ChatGPT Desktop Codex | `codex` target reaches it via shared `$CODEX_HOME` | ChatGPT Desktop is not a detectable surface; users cannot see that installing to Codex covers the app |
| ChatGPT Desktop work | Nothing | No file-based mechanism exists at all; needs an explicit, documented boundary plus a guided connector handoff for remote engines |

## 4. Decisions to record (new ADR 0026, first deliverable)

Per ADR 0013 ("a new client target requires an architectural decision"), one
new ADR — *Claude Desktop and ChatGPT Desktop surface coverage* — records:

1. **`claude-desktop` mutation extends to Linux**, using
   `~/.config/Claude/claude_desktop_config.json` under the existing ownership
   and atomic-write contract. Windows mutation remains excluded (unchanged
   ADR 0013 boundary).
2. **One target, three Claude Desktop surfaces.** The `claude-desktop` target
   is normatively documented as feeding Chat, Cowork, and local Code-tab
   sessions. The installer does not add a separate "cowork" target because no
   separate file exists.
3. **The stdio-only and no-forwarded-env gates on `claude-desktop` are
   confirmed**, now with the corruption evidence for `url` entries.
4. **`chatgpt-desktop` becomes a harness surface mapped onto the existing
   `codex` configuration target**, following the Antigravity CLI/IDE
   precedent of two surfaces sharing one target. No new config file, adapter,
   or state contract is introduced.
5. **The ChatGPT work surface is a documented non-target.** Because targets
   are defined by writable local configuration files, and ChatGPT connectors
   are account-level and remote-only, the installer must not model it as a
   (permanently blocked) target ID. Support takes the form of a **guided
   connector handoff**: after a remote (`--http`) registration, the installer
   prints the canonical `/mcp` URL with step-by-step developer-mode
   instructions. This keeps the exhaustive `Record<ConfigurationTargetId, …>`
   maps, persisted state, and transactions honest.

## 5. Deliverables

Each deliverable is one cohesive commit (tests + implementation + docs),
following RED → GREEN → REFACTOR.

### Deliverable A — ADR 0026 and normative doc updates

Documentation-only. Write the ADR above; update
`docs/README.md` (delivered-changes list once shipped) and the installer
reference's platform statements.

*Acceptance:* ADR merged with Proposed→Accepted status flip in the delivery
commit; links valid.

### Deliverable B — Claude Desktop on Linux (work + code coverage)

Touch points (all in `packages/installer`):

- `src/target-config-evidence.ts:444-450` — replace the darwin-only ternary
  with a per-platform path map: darwin
  `Library/Application Support/Claude/claude_desktop_config.json`, linux
  `.config/Claude/claude_desktop_config.json`, win32 → `unsupportedProbe`.
- `src/harness-catalog.ts:62-67` — extend `executableCandidates` with the
  Linux desktop binary name(s) (`claude-desktop` per the apt package;
  **verify the installed binary name against the .deb during
  implementation**). Update the target `reloadHint` (`:133-136`) to: restart
  the app fully; servers appear in Chat, Cowork, and local Code-tab sessions.
- No adapter change: the `claude` JSON dialect, stdio-only compatibility, and
  `detached` toggle strategy are unchanged.

Tests:

- `test/target-config-evidence.test.ts` — linux present/absent/unsafe cases
  mirroring the existing darwin cases at `:295-334`; win32 stays blocked.
- `test/harness-detection.test.ts` — updated catalog literal.
- `test/harness-detection-sentinels.test.ts` + fixture — linux detection of
  the desktop binary.
- Docs: installer reference "Supported targets" table gains the Linux path;
  the "macOS-only" sentence is replaced.

*Acceptance:* on a simulated linux platform with an owned config file, the
target is eligible and a stdio install round-trips; on win32 it reports
`TARGET_UNSUPPORTED`; macOS behavior is byte-identical to today.

### Deliverable C — Document and de-duplicate the Claude "code" path

The code surface needs no new writer — it needs correct semantics and docs:

- Installer reference: a new "Claude Desktop and the Code tab" subsection
  explaining which file feeds which surface, and the duplicate-name
  precedence (Code tab prefers `claude_desktop_config.json` over
  `~/.claude.json`/`.mcp.json`).
- `read-only-inventory.ts` / install summary: when **both** `claude-code` and
  `claude-desktop` are selected for the same engine, add a one-line note that
  desktop Code-tab sessions will use the `claude_desktop_config.json`
  definition for the duplicated server name. (Presentation-only; no
  transactional change.)

*Acceptance:* summary note asserted in `test/install-session.test.ts`; docs
build passes.

### Deliverable D — ChatGPT Desktop surface for the Codex target

Following the Antigravity two-surfaces-one-target precedent:

- `src/harness-catalog.ts:4-16` — add `"chatgpt-desktop"` to the surface ID
  union; add a surface entry `{ id: "chatgpt-desktop", displayName:
  "ChatGPT Desktop (Codex)", executableCandidates: ["ChatGPT",
  "chatgpt"], targetId: "codex" }` (verify binary names during
  implementation; GUI apps are typically detected via config evidence, so the
  candidates are best-effort).
- `src/harness-detection.ts:141-156` — add the multi-surface display-name
  case so `codex` renders as e.g. "Codex + ChatGPT Desktop (Codex)" when both
  surfaces are present (or reuse the generic join).
- Target `reloadHint` for `codex` (`harness-catalog.ts:139-142`) — mention
  that the ChatGPT app's Codex surface picks up new servers on its next
  session.
- **No registry, adapter, evidence, state, or session changes** — the target
  set is unchanged, so `ConfigurationTargetId` and every exhaustive map stay
  as they are.

Tests: catalog literal + length updates in `test/harness-detection.test.ts`,
detection-sentinel arrays, and a display-name case.

*Acceptance:* with a fake `ChatGPT` executable on PATH and a
`~/.codex/config.toml`, detection lists the surface, maps it to `codex`, and
an install lands in the one shared TOML file exactly as today.

### Deliverable E — ChatGPT work surface: guided connector handoff

- Extend the remote-install flow (`remote-install-source.ts` consumers /
  install summary) so a successful `--http` registration prints a short
  "Connect from ChatGPT" block: the canonical `https://…/mcp` URL and the
  developer-mode steps (Settings → Apps & Connectors → Advanced → Developer
  mode → New connector), noting OAuth and that stdio engines cannot be
  reached by ChatGPT.
- Installer reference: a "ChatGPT Desktop" section documenting the boundary —
  Codex via the `codex` target; the chat surface only via account-level
  remote connectors; local stdio engines must be deployed (see
  `@invokta/deploy`) before ChatGPT can reach them.
- The block is plain output — no network call, no new prompt, no state.

*Acceptance:* summary text asserted in tests; network and filesystem
sentinels stay green; docs list ChatGPT explicitly in a client-coverage
matrix.

### Deliverable F — Changelog and validation record

`CHANGELOG.md` entry following the existing precedent phrasing (surface and
target counts), plus `docs/validation-record.md` update if applicable.

## 6. Explicit non-goals

- **Windows mutation** for any target — still requires the platform ownership
  and atomic-write contract ADR 0013 reserved for a separate decision.
- **Writing remote entries into `claude_desktop_config.json`** (corrupts the
  file) or bundling `mcp-remote` bridges on the user's behalf (spawns a
  network-touching process the installer cannot vouch for).
- **MCPB (`.mcpb`) bundle generation** for Claude Desktop one-click installs —
  a promising future distribution channel, but a packaging concern for
  `@invokta/deploy`/`create-invokta-engine`, not an installer mutation, and
  it has no silent-install API today.
- **Automating ChatGPT connector registration** — account-level, OAuth-gated,
  and UI-only; any automation would break the no-network boundary.
- A separate Cowork target or per-project (`.mcp.json`) scope (the latter
  additionally triggers Claude Code's interactive approval prompt and stays
  out of user-scope policy).

## 7. Risks and open questions

1. **Linux binary/config names need empirical verification** (`.deb` binary
   name, exact XDG path casing) before Deliverable B lands; the beta status
   means paths could shift — pin with a doc citation in the ADR.
2. **Cowork bridging of `claude_desktop_config.json` is community-verified,
   officially implied** — the docs promise the same experience but do not
   name the file for Cowork explicitly. The ADR should phrase Cowork coverage
   as "as documented by the desktop app" rather than a hard guarantee.
3. **ChatGPT Desktop binary names** for surface detection are cosmetic; if
   they prove unstable, config evidence for `~/.codex/config.toml` already
   makes the target eligible, so Deliverable D degrades gracefully.
4. **User-visible naming**: "ChatGPT Desktop (Codex)" must not imply the chat
   surface is being configured. Wording review is part of Deliverable D.
5. If the desktop app later ships a supported remote-server file for
   connectors, revisit Decision 5 with a follow-up ADR.

## 8. Suggested sequence

A (ADR) → B (Linux) → D (ChatGPT/Codex surface) → C (code-path docs/note) →
E (connector handoff) → F (changelog). B and D are independent and can be
developed in parallel; C and E are small and depend only on A's wording.
