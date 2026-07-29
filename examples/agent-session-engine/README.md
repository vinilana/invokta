# Agent session engine example

This example persists an agent session independently of Cursor, Antigravity,
Claude Code, or Codex. A coordinator can inspect the current phase, checkpoint,
tasks, owners, and verification evidence, then hand work to another harness
without depending on the first harness's private transcript format.

The framework still does not become a harness or workflow runtime. Session
ordering, task ownership, persistence, and hook normalization are domain rules
and injected infrastructure of this custom engine.

## Capabilities

| Capability | Observable behavior |
| --- | --- |
| `agent-session.start` | Creates one portable session identifier and objective. |
| `agent-session.record-hook-event` | Stores payload-free lifecycle metadata from a harness hook. |
| `agent-session.create-task` | Creates a task with a phase and optional harness/agent owner. |
| `agent-session.update-task` | Advances, checkpoints, completes, unassigns, or hands off a task using its expected revision. |
| `agent-session.checkpoint` | Records the session phase, status, checkpoint, and next action using the expected session revision. |
| `agent-session.get` | Returns the complete state and a bounded `resumeContext` for another harness. |

Every direct, CLI, and MCP call reaches these handlers only through
`engine.invoke`. The command hook also calls `runCli`, so hook events exercise
the same validation, authorization, execution, persistence, and engine events
as an operator's CLI command.

## Durable state and concurrency

The default `FileAgentSessionStore` writes one JSON document per portable
session under `AGENT_SESSION_ENGINE_DATA_DIR`, or `.agent-sessions/` in the
current directory when the variable is absent. Files use a fixed-length SHA-256
name derived from the validated session ID. The store uses a per-session
exclusive file lock with an owner token and process identity, optimistic
revisions, a synced temporary file, and atomic rename. A lock left by a
terminated process becomes recoverable after 30 seconds; elapsed time alone
never permits one live process to steal another process's lock.

The example makes these operational limits explicit:

- 256 tasks per session;
- 10,000 hook events per session;
- 64 linked native harness sessions;
- 4,194,304 input bytes per hook process;
- 2,000 milliseconds to acquire a live session lock;
- 4,000 characters per checkpoint, next action, or evidence value;
- 20 open tasks in injected resume context; `agent-session.get` retains the
  complete task list;
- 16,000 characters in injected resume context, with an explicit truncation
  notice when the complete state is larger.

A process crash cannot partially replace a valid session document. This local
file adapter is not a distributed database: place the data directory on one
host-local filesystem and replace the store port when multiple hosts must write
the same session. The JSON layout is an example-version persistence format, not
a cross-version migration contract; migrate or replace the store before changing
its schema in an existing deployment.

## Build and create a session

From the repository root:

```sh
yarn build

export AGENT_SESSION_ENGINE_DATA_DIR="$PWD/.agent-sessions"
export AGENT_SESSION_ENGINE_SESSION_ID="delivery-42"

node examples/agent-session-engine/dist/cli.js run agent-session.start --input \
  '{"sessionId":"delivery-42","objective":"Deliver the hook integration","workspaceRoot":"/workspace/ai-engines"}'

node examples/agent-session-engine/dist/cli.js run agent-session.create-task --input \
  '{"sessionId":"delivery-42","taskId":"implement-hooks","title":"Implement harness hook adapters","phase":"implementation","assignedHarness":"codex","assignedAgentId":"primary"}'
```

The environment variables must be inherited by every harness process that
participates in the handoff. `AGENT_SESSION_ENGINE_SESSION_ID` maps different
native conversation IDs onto the same portable session. Without it, the hook
uses `<harness>:<native-session-id>` as an isolated default when the native ID
is filename-safe, or a deterministic hash of that native ID otherwise.

Record a resumable checkpoint with the latest session revision returned by the
previous mutation:

```sh
node examples/agent-session-engine/dist/cli.js run agent-session.checkpoint --input \
  '{"sessionId":"delivery-42","expectedRevision":2,"phase":"implementation","status":"paused","checkpoint":"The contracts and tests are complete.","nextAction":"Implement the hook adapter and run the focused suite."}'
```

Hand the task to a Claude Code agent with the task revision returned by the
previous task mutation:

```sh
node examples/agent-session-engine/dist/cli.js run agent-session.update-task --input \
  '{"sessionId":"delivery-42","taskId":"implement-hooks","expectedTaskRevision":1,"assignedHarness":"claude-code","assignedAgentId":"implementer"}'
```

Stale task or session revisions fail instead of silently overwriting another
agent's progress. Completing a task also requires non-empty `evidence`.

## Connect harness hooks

The example configurations follow the current official hook references for
[Cursor](https://cursor.com/docs/hooks),
[Antigravity](https://antigravity.google/docs/hooks),
[Claude Code](https://code.claude.com/docs/en/hooks), and
[Codex](https://developers.openai.com/codex/config-advanced#hooks).

After building, copy or merge the applicable example from `hooks/`:

| Harness | Example | Project location |
| --- | --- | --- |
| Cursor | `cursor.hooks.json` | `.cursor/hooks.json` |
| Antigravity | `antigravity.hooks.json` | `.agents/hooks.json` |
| Claude Code | `claude-code.settings.json` | `.claude/settings.json` |
| Codex | `codex.hooks.json` | `.codex/hooks.json` |

Do not overwrite an existing settings file; merge its hook map. The example
commands assume the harness starts at this repository root. In another project,
install the built example in a stable location and replace each command with an
absolute path. Codex project hooks also require the project to be trusted and
the hook definition to be reviewed in `/hooks` before they run.

On a resumed Codex or Claude Code `SessionStart`, the hook returns
`hookSpecificOutput.additionalContext`. Cursor receives `additional_context` on
`sessionStart`. Antigravity receives an ephemeral resume step on its first
`PreInvocation`. Other configured handlers return the neutral output required
by that harness.

Hook events are observations. They do not implicitly advance the portable
phase, task status, checkpoint, or owner. A coordinator must invoke the task and
checkpoint capabilities for those state transitions. Concurrent hook events are
returned in successful persistence order; `observedAt` records each recorder's
wall-clock observation and is not a distributed causal clock.

### Coverage is bounded by the harness

The configurations capture the safe session, agent, task, compaction, model
invocation, and tool events each harness exposes. They do not claim visibility
into an action for which the harness emits no hook.

- Codex documents that hosted tools and specialized tool paths may bypass local
  tool hooks. Its config still registers every documented Codex lifecycle event.
- Antigravity requires `PreToolUse` hooks to return an authorization decision.
  This observer deliberately omits that event because choosing `allow`, `ask`,
  or `deny` would change permission behavior. `PostToolUse` and all neutral
  invocation/stop events are recorded.
- Claude Code `WorktreeCreate` changes worktree creation behavior and
  `FileChanged` requires an explicit watch list. Neither is a neutral lifecycle
  observer, so this example omits those two events and registers every other
  currently documented Claude Code event.
- Cursor coverage is the set of events emitted by the installed Cursor version;
  generic and legacy tool events may both fire and are stored as distinct event
  names.

When a hook supplies a stable native occurrence identifier, the normalizer
creates a deterministic event ID from that occurrence and the SHA-256 of the
received payload, so a byte-identical redelivery is idempotent. When a hook does
not supply one, each hook process assigns a new delivery identity so distinct
byte-identical lifecycle occurrences are never collapsed. Such events can be
duplicated if the harness retries them, so this example promises neither
distributed exactly-once delivery nor automatic retry deduplication.

## Payload privacy

The hook process reads the harness JSON only to select bounded metadata:
portable/native session IDs, event name, tool name, native agent/task IDs,
outcome category, workspace root, observation time, and a SHA-256 digest. It
does not persist prompts, assistant responses, reasoning, tool arguments, tool
responses, transcripts, credentials, or raw error messages. The digest proves
whether two received payloads were byte-identical; it is not a recovery copy.

Hook recording errors go to `stderr`. Monitor them: a full disk, corrupt state,
expired event budget, or hook timeout means the harness event was not durably
recorded.

## Other adapters

Run the deterministic direct flow:

```sh
node examples/agent-session-engine/dist/direct.js direct-demo
```

Publish the same capabilities over MCP stdio:

```sh
node examples/agent-session-engine/dist/mcp-stdio.js
```

Or over authenticated stateless MCP HTTP:

```sh
AGENT_SESSION_ENGINE_BEARER_TOKEN=development-only-token \
  node examples/agent-session-engine/dist/mcp-http.js
```

## Verify

```sh
yarn workspace @ai-engine/example-agent-session test
yarn workspace @ai-engine/example-agent-session typecheck
yarn workspace @ai-engine/example-agent-session build
```
