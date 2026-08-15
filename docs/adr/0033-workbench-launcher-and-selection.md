# ADR 0033: Workbench launcher and workbench selection

- Status: Accepted
- Date: 2026-08-15

## Context

ADR 0022 made bare `invokta-devtools` and `invokta-devtools open` the idle MCP
workbench. ADR 0032 added `open --cli` as a sibling idle workbench and put an
in-session switch between the two out of scope, so each workbench documents the
other by printing the command that starts it.

That leaves two gaps. A developer who does not already know the flag has no way
to see what the tool offers: the entry point silently picks one of the two
workbenches for them. A developer who does know the flag still has to stop the
process and retype a command to look at the other surface, and the port they
had open changes underneath them.

Both workbenches are inert until the developer selects Connect. Neither loads a
workspace, spawns a target, or opens an outbound connection at startup, so
mounting both costs nothing at rest, and the reason to keep them on separate
processes was never isolation of running work.

## Decision

`invokta-devtools open`, and the bare invocation, start one loopback server —
the launcher — that mounts both idle workbenches on one origin:

- `/` serves the chooser: which workbench to open, and the `serve` command for
  the project-workspace path that neither workbench covers.
- `/mcp` and `/cli` serve the MCP and CLI workbench shells.
- `/api/mcp` and `/api/cli` mount their JSON APIs. The unprefixed `/api` of a
  single-workbench server is not mounted.
- `/assets` serves one shared bundle, stylesheet, and favicon.
- `/oauth/callback` and `/oauth/result/*` stay at the root on the literal
  loopback authority, because ADR 0023's redirect URL is what the MCP client
  accepts and it names no workbench.

`--mcp` and `--cli` select the path the ready line points at. They are
mutually exclusive, either may appear with `--port`, and neither unmounts the
other workbench. Standard output keeps ADR 0021's single ready line; the
selected workbench is the path inside it.

Each workbench keeps its own controller, browser sessions, and CSRF tokens. A
session authorized for one workbench is not authorized for the other. The
switch in the workbench chrome is a same-origin link between two pages, not a
state transfer: it carries no connection, target, or activity across, and the
workbench left behind keeps whatever it had attached.

`serve` is unchanged. It remains the single-purpose project workspace with its
own engine host, and it is not reachable from the launcher.

The launcher MUST NOT mount a third surface, share state between the two
workbenches, aggregate their activity, persist the selection, or start a
workbench's target on behalf of the chooser. It MUST bind only loopback, and it
MUST keep the per-workbench isolation the two ADRs above specify.

This decision supersedes ADR 0032's scope limit on an in-session switch and
ADR 0022's rule that a bare invocation opens the MCP workbench.

## Consequences

- A first run shows both workbenches and what each one attaches to, instead of
  silently choosing one.
- Switching workbench is a link, so the port, the process, and the other
  workbench's attached target all survive it.
- Bare `invokta-devtools` and `open` now land on the chooser. `open --mcp`
  restores the previous landing, and `open --cli` is unchanged in intent.
- The ready line carries a path (`/`, `/mcp`, or `/cli`). A reader that matched
  the whole line has to match the path too; this requires release notes.
- Both controllers exist in one process. Both stay idle, so the process still
  spawns nothing until a Connect in one of them.
- Adding a third workbench, an aggregated view, or shared state between the
  workbenches requires another architectural decision.
