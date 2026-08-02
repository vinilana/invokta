# Production registry review

`capabilities.json` is deliberately empty during workspace and CI development.
The first production release of `@invokta/installer` is blocked until a real
Action Engine MCP artifact or endpoint satisfies the gate below. A private example,
test fixture, placeholder command, or unverified URL is not a production entry.

For every proposed production entry, the reviewer must record:

1. the separately owned upstream artifact or endpoint, its immutable release
   version, and its responsible maintainer;
2. the exact registry ID, server name, transport, command and arguments or URL,
   environment-variable names, and declared capability IDs;
3. evidence that the upstream release uses MCP to list and call every declared
   capability ID through the same descriptor;
4. the nine-target compatibility report produced by registry validation,
   including stable reasons for every unsupported target;
5. a security review confirming that command arguments and endpoints contain no
   credentials, tokens, private keys, passwords, cookies, or TLS bypasses and
   that all runtime credentials remain environment references; and
6. an offline smoke test of the packed installer in an isolated home and
   `PATH`, proving that it writes the reviewed descriptor without launching the
   command, resolving DNS, or opening a network connection.

The production entry and its evidence land together in the release-gate slice.
Changing an entry requires registry validation, renewed compatibility and
security review, and a new installer package release. The installer never
downloads, launches, probes, or updates the upstream artifact.
