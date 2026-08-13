# ADR 0027: Windows installer ownership identity

- Status: Accepted
- Date: 2026-08-13

## Context

ADR 0013 kept Windows configuration mutation unsupported until the installer
had an equivalent no-follow ownership and atomic-write contract for that
platform. Every installer safety layer derived the invoking user from
`process.getuid()`: engine manifest loading, path root and component capture,
state loading, target configuration evidence, and created-object verification
in the transaction filesystem.

Windows exposes no POSIX uid. Node.js there reports owner id `0` and advisory
permission bits for every filesystem object and cannot reveal the owning
security identifier without native code, which the installer's no-execution
boundary forbids. The uid derivation therefore produced a sentinel that every
check rejected, so a valid Action Engine installed globally through npm failed
closed with `ENGINE_PATH_UNSAFE` immediately after harness detection, and all
other mutating operations were equally unreachable on Windows.

## Decision

The installer replaces the raw uid with one closed ownership identity that
every safety layer shares. A `posix-user` identity carries the captured uid on
platforms that expose `process.getuid()`. A `windows-principal` identity is
captured only when the platform is `win32` and no uid exists; it carries
Node's constant reported owner id `0`. When neither form can be captured, the
identity is absent and every consumer keeps failing closed with its existing
diagnostic, such as `ENGINE_PATH_UNSAFE`, `STATE_INVALID`, or
`HARNESS_CONFIG_UNSAFE`.

POSIX validation is unchanged: every trusted root and path component must be
owned by the captured uid, private files and directories keep their exact
`0o600` and `0o700` modes, and reads and exclusive creations pass `O_NOFOLLOW`
to the kernel.

Under the Windows principal, an owner-id comparison proves nothing because the
reported value is constant, so it is not treated as ownership evidence. The
existing protections continue to carry the contract and remain mandatory:
path containment inside the captured root, rejection of symbolic links and
junctions by their inspected kind, device-and-inode identity capture and
revalidation before every write, exclusive temporary-file creation with
same-directory atomic rename, and bounded locking. Where the kernel flag does
not exist, no-follow opening is enforced by inspecting the path first and then
comparing the opened descriptor's identity against that inspection. Exact
POSIX mode equality is not asserted because Windows `chmod` only toggles the
read-only attribute; requested modes stay advisory there, and directory
confinement is the user profile's access-control lists. The state location
contract is unchanged on every platform.

The public command surface, manifest contract, diagnostics, and exit statuses
are unchanged. Engine installation, engine-scoped removal, the embedded engine
commands, direct remote registration, and management operations become
available on Windows for targets whose default user configuration is resolved
relative to the home directory. Visual Studio Code and Claude Desktop keep
their documented platform scope; adding their Windows `%APPDATA%` locations,
or any richer Windows owner verification, requires a separate architectural
decision. This decision supersedes ADR 0013's sentence deferring Windows
configuration mutation.

## Consequences

- A globally installed engine package registers and removes itself on Windows
  through the existing transactions, and the POSIX contract is untouched.
- The ownership identity becomes part of the installer's internal option
  contracts; embedders of `@invokta/installer/engine` observe no interface
  change.
- On Windows the installer cannot distinguish another principal's files inside
  a directory the user can write to; that residual risk is accepted because it
  matches the platform's own confinement model and the identity, no-follow,
  and containment checks still hold.
- Continuous validation simulates Windows semantics on POSIX hosts through a
  Windows-like filesystem adapter; behavior tied to real NTFS access-control
  semantics remains outside automated coverage and is documented here.
