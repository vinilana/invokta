# OAuth client interoperability checklist

Use this manual checklist before releasing changes to MCP OAuth discovery, the
official self-hosted OAuth example, or the devtools OAuth client. Product
availability and account prerequisites change independently of the protocol;
verify each client's current official documentation on the test date.

## Record once per client

- [ ] Client: Gemini custom connected app, ChatGPT custom MCP connector, or a
      named local loopback MCP client.
- [ ] Product version or web release date.
- [ ] Account/workspace tier, region, language, administrator policy, activity
      history, developer mode, and connector entitlement as applicable.
- [ ] MCP URL and server commit/image tag, without credentials or query values.
- [ ] Browser and operating system for interactive flows.
- [ ] Registration mechanism: pre-registration, CIMD, or DCR.
- [ ] Token endpoint authentication method, without client ID or secret.
- [ ] Result and last completed protocol stage.

Record a missing product entitlement or UI capability as a **product
prerequisite**, not an OAuth protocol failure. Record a well-formed request that
the server rejects as a protocol/interoperability result with only route,
status, and stable error code.

## Server preflight

- [ ] `invokta-deploy probe --url <mcp-url> --expect alive` succeeds.
- [ ] `invokta-deploy inspect-oauth --url <mcp-url>` succeeds.
- [ ] Protected Resource Metadata names the exact MCP resource and issuer.
- [ ] Authorization Code and S256 are advertised.
- [ ] The selected registration mechanism is advertised or preconfigured.
- [ ] The example-local DCR probe creates and deletes one temporary client.
- [ ] A current database backup and rollback image exist.
- [ ] Sanitized engine and OAuth logs are available for the test window.

## Fresh interactive flow

Run every client from a new connection, not a previously authorized session:

- [ ] Discovery reaches Protected Resource Metadata.
- [ ] Authorization Server discovery reaches OAuth or OIDC metadata in the
      required order.
- [ ] Registration or pre-registered client selection completes once.
- [ ] The authorization request includes `resource`, an exact redirect URI,
      state, and an S256 code challenge.
- [ ] Owner login succeeds without revealing or resetting the credential.
- [ ] One click on Authorize returns the first consent response and resumes the
      authorization request.
- [ ] The callback reaches the client with one matching state value.
- [ ] The client calls `/token` before the code expires.
- [ ] The token request uses the same redirect URI, the PKCE verifier, and the
      exact MCP resource.
- [ ] The first authenticated `/mcp` initialization succeeds.
- [ ] Tool listing contains the expected capability.
- [ ] One deliberate read-only tool invocation succeeds through
      `engine.invoke`.
- [ ] Replaying the callback, code, consent, or rotated refresh token is
      rejected.

## Client coverage

### Gemini custom connected app

- [ ] Add the MCP URL without manually entering an OAuth client ID or secret
      when DCR is enabled.
- [ ] If the UI requests manual credentials before contacting `/reg`, record
      the account/product prerequisites and the last observed discovery stage.
- [ ] If consent creates a code but `/token` is never called, classify the
      callback/product behavior separately from the successful server consent.

### ChatGPT custom MCP connector

- [ ] Enable the current connector/developer prerequisites documented by
      OpenAI for the test workspace.
- [ ] Confirm the connector uses an advertised registration path or the
      intentionally configured client.
- [ ] Confirm reconnecting starts a fresh flow after credentials are revoked;
      do not rely on a token retained from an earlier server build.

### Local loopback client

- [ ] Use an exact `http://127.0.0.1:<port>/...` callback owned by the client.
- [ ] Confirm state is single-use and the result page removes code and state
      from its visible URL.
- [ ] Confirm shutdown, cancellation, and timeout clear the client registration,
      PKCE verifier, code, token, and refresh token from retained diagnostics.

## Secret-redaction audit

Search test output, browser-visible state, Activity, diagnostics, and support
artifacts. None may contain:

- [ ] owner password or password hash;
- [ ] session or interaction cookie;
- [ ] client ID when it is treated as sensitive, client secret, or registration
      access token;
- [ ] authorization code, PKCE verifier, or state;
- [ ] access token, refresh token, or complete JWT;
- [ ] raw registration, discovery, or token response; or
- [ ] database connection password.

The release record should contain only client/version, prerequisites, topology,
registration/auth method, stage, route, status, stable error code, and the final
pass/fail classification.
