# API key authentication example

This example authenticates machine-to-machine callers with hashed API keys and
publishes one capability, `identity.whoami`, that reports the identity the
verifier proved. It is the upgrade path from the static bearer token in
[`support-engine`](../support-engine/src/mcp-http.ts): the same
`serveMcpHttp` hook, but with a rotatable key set, hashed storage, and a
constant-time comparison.

A key is `<keyId>.<secret>`. The key id is a public lookup handle; the secret
half is the credential. The engine stores only `sha256(secret)`, so a leaked
configuration file or database dump yields no usable key.

The example is deterministic and makes no network calls.

## Architecture

```text
MCP HTTP request                      direct invocation
       |                                     |
       v                                     v
 authenticate hook                    verify configured key
       |                                     |
       +----------> ApiKeyVerifier <---------+
                          |
                    ApiKeyRegistry (key id -> record)
                          |
                          v
              Principal { id: serviceName,
                          attributes: { keyId, scopes } }
                          |
                          v
                    engine.invoke
                          |
                          v
                   identity.whoami
```

- `src/identity/verifier.ts` parses the key, looks the key id up in an
  `ApiKeyRegistry`, and compares `sha256(secret)` with the stored digest using
  `timingSafeEqual`. It also parses and validates the configured key set.
- `src/identity/principal.ts` maps a verified key to the minimal `Principal`.
- `src/capabilities/whoami.ts` declares `access: "authenticated"` and derives
  its whole result from `context.principal`, never from input.
- `src/mcp-http.ts` is the HTTP composition root: it reads one `Bearer`
  credential and wires the verifier into `auth.mode: "required"`.
- `src/direct.ts` runs the same verifier on a local channel.

The hook returns a `Principal` for a valid key, `null` for a missing, malformed,
unknown, or wrong-secret credential (HTTP 401), and rejects only when the
registry lookup itself cannot complete (HTTP 500).

## Generate a key and its hash

Print a new key once, keep the `hash` line, and hand the `key` line to the
calling service. The plaintext secret is never stored by this engine:

```sh
node -e 'const c=require("node:crypto");const id="svc_"+c.randomBytes(4).toString("hex");const s=c.randomBytes(32).toString("base64url");console.log("key:  "+id+"."+s);console.log("keyId:"+id);console.log("hash: "+c.createHash("sha256").update(s).digest("hex"))'
```

## Configure the key set

`API_KEY_ENGINE_KEYS` is a JSON array of active keys. Every entry stores a hex
sha256 digest, never a secret:

```json
[
  {
    "keyId": "svc_9f21c4a7",
    "secretHash": "0f5a…64 hex characters…c1",
    "serviceName": "reports-worker",
    "scopes": ["identity:read"]
  }
]
```

Rotate by adding a second entry with a new key id and the same `serviceName`,
switching the caller, then removing the old entry. Both keys authenticate to the
same principal while the switch is in flight.

## Run the example

From the repository root, build first:

```sh
yarn build
```

Start the stateless MCP HTTP adapter on the loopback default:

```sh
API_KEY_ENGINE_KEYS='[{"keyId":"svc_9f21c4a7","secretHash":"<hex sha256>","serviceName":"reports-worker","scopes":["identity:read"]}]' \
  node examples/auth-api-key-engine/dist/mcp-http.js
```

Call it with the key that hashes to the configured digest:

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H 'authorization: Bearer svc_9f21c4a7.<secret>' \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

An absent, malformed, unknown, or wrong-secret key returns HTTP 401 before
`engine.invoke` runs.

Run the same verification on a local channel:

```sh
API_KEY_ENGINE_KEYS='[…]' \
  API_KEY_ENGINE_CREDENTIAL='svc_9f21c4a7.<secret>' \
  node examples/auth-api-key-engine/dist/direct.js
```

## Use it against a real deployment

Replace `createInMemoryApiKeyRegistry` with a registry backed by the store that
already owns your service credentials — a database table, a secret manager, or
an internal issuing service:

```ts
const registry: ApiKeyRegistry = {
  async findByKeyId(keyId, { signal }) {
    return database.findApiKey(keyId, { signal });
  },
};
```

Keep the contract: return `null` for an unknown key id, and throw when the store
is unavailable so an outage is reported as HTTP 500 instead of as an invalid
credential. Nothing else changes.

## Verify the example

```sh
yarn workspace @invokta/example-auth-api-key test
yarn workspace @invokta/example-auth-api-key typecheck
yarn workspace @invokta/example-auth-api-key build
```

The tests cover the full invalid-credential matrix, registry failure, rotation,
and that no credential material reaches the principal or any error message.
