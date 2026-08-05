# Firebase Auth engine example

This example authenticates MCP HTTP requests with Firebase Auth ID tokens and
exposes one capability, `identity.whoami`, whose result is derived only from the
verified `Principal`.

Firebase ID token verification belongs to the Firebase Admin SDK, so this
package defines it as a **port** instead of depending on `firebase-admin`:

- `src/identity/verifier.ts` — the `FirebaseIdTokenVerifier` port, the Admin SDK
  adapter (`createAdminIdTokenVerifier`) written against a structural view of
  `getAuth()`, and the failure classification that decides invalid credential
  versus unavailable verification.
- `src/identity/principal.ts` — verified claims to `Principal`, as an allowlist.
- `src/capabilities/whoami.ts` — `access: "authenticated"`; reads only
  `context.principal`.
- `src/mcp-http.ts` — the `serveMcpHttp` composition root with
  `auth.mode: "required"`.
- `src/direct.ts` — the embedded surface: a host that already verified the token
  maps the claims once and calls `engine.invoke`.

The three hook outcomes required by
[`docs/http-authentication.md`](../../docs/http-authentication.md) are:

| Situation | Hook result | HTTP |
| --- | --- | --- |
| Verified ID token for this project | `Principal` | 200 |
| Missing, malformed, expired, revoked, or foreign-project token | `null` | 401 |
| Verification could not complete | rejected promise | 500 |

## Run it against a real Firebase project

Copy `src/identity/` and `src/mcp-http.ts` into your application, install
`firebase-admin` there (this example does not ship it), and wire the adapter at
your composition root:

```ts
import { getAuth } from "firebase-admin/auth";

import { createAdminIdTokenVerifier } from "./identity/verifier.js";
import { startFirebaseMcpHttp } from "./mcp-http.js";

await startFirebaseMcpHttp({
  verifier: createAdminIdTokenVerifier(getAuth(), { checkRevoked: true }),
  projectId: process.env.FIREBASE_PROJECT_ID ?? "",
  customClaimNames: ["role"],
  port: 3000,
});
```

Environment variables used by that composition root:

| Variable | Purpose |
| --- | --- |
| `FIREBASE_PROJECT_ID` | The only project whose ID tokens are accepted. It is both the expected `aud` and the tail of the expected `iss` (`https://securetoken.google.com/<project-id>`). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account credentials the Admin SDK initializes with. Keep it in the deployment's secret mechanism. |
| `FIREBASE_AUTH_EMULATOR_HOST` | Local development only, for example `127.0.0.1:9099`. The Auth emulator issues unsigned ID tokens that only an emulator-aware Admin SDK accepts. Never set it in production. |

Call the endpoint with an ID token obtained by a Firebase client SDK
(`getIdToken()`):

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity.whoami","arguments":{}}}'
```

## Run the embedded example

No credential and no Firebase project are involved: the script starts from a
sample claim set, exactly as a route handler holds it after
`getAuth().verifyIdToken()` returned.

```sh
yarn workspace @invokta/example-auth-firebase build
yarn workspace @invokta/example-auth-firebase direct
```

## Verify the example

Every test is offline: the port is exercised with a fake verifier and a fake
`getAuth()`, so no network call and no real credential is needed.

```sh
yarn workspace @invokta/example-auth-firebase test
yarn workspace @invokta/example-auth-firebase typecheck
yarn workspace @invokta/example-auth-firebase build
```

Read [`recipes/auth/firebase`](../../apps/docs/src/content/docs/recipes/auth/firebase.mdx)
for the step-by-step integration and
[`docs/capability-authorization.md`](../../docs/capability-authorization.md) for
the policy half.
