import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * A minimal OAuth 2.1 authorization server for tests, and the verifier for the
 * access tokens it issues.
 *
 * This is a test fixture, not a framework feature. Invokta implements zero
 * authentication and zero authorization-server functionality
 * (`docs/scope-and-limits.md`, "Auth or PDP implementations | 0"). The fixture
 * exists only so the OAuth-capable MCP client in `@invokta/mcp` has something
 * to authorize against on a loopback origin.
 *
 * It implements exactly the chain the MCP SDK's client walks: RFC 8414
 * metadata, RFC 7591 dynamic registration, an RFC 7636 (S256) authorization
 * code bound to an RFC 8707 `resource`, and the authorization-code grant. There
 * is no user interaction and no consent screen — `GET /authorize` redirects
 * back immediately. Everything is in memory and dies with the process.
 */

const CODE_TTL_MS = 60_000;
const TOKEN_TTL_SECONDS = 300;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_OUTSTANDING_CODES = 64;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/u;

/**
 * The access token is a signed pair `<payload>.<signature>`, both base64url,
 * where the payload is JSON and the signature is HMAC-SHA256 over the payload
 * segment. It is deliberately not a JWT: with a single algorithm and a single
 * key there is nothing to negotiate, so the resource server verifies a token
 * with `node:crypto` alone and no JWT dependency enters the repository. The
 * `aud` claim carries the RFC 8707 `resource` the code was issued for, which is
 * what makes the token audience-bound.
 */
function signAccessToken(payload, signingKey) {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", Buffer.from(signingKey, "base64url"))
    .update(segment, "utf8")
    .digest("base64url");
  return `${segment}.${signature}`;
}

function equalStrings(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies a fixture access token and returns its payload, or `null` when the
 * token is unreadable, unsigned by `signingKey`, expired, or issued for a
 * different audience. This is the resource-server half of the token format
 * above; `oauth-engine.mjs` calls it from its `authenticate` hook.
 */
export function verifyAccessToken(token, { signingKey, audience }) {
  if (typeof token !== "string") return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return null;
  const segment = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", Buffer.from(signingKey, "base64url"))
    .update(segment, "utf8")
    .digest("base64url");
  if (!equalStrings(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.aud !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.aud !== audience) return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendOAuthError(response, status, error, description) {
  sendJson(
    response,
    status,
    { error, error_description: description },
    { "cache-control": "no-store" },
  );
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isFormUrlEncoded(value) {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

/** RFC 8707 requires an absolute URI with no fragment. */
function isValidResource(value) {
  try {
    return new URL(value).hash === "";
  } catch {
    return false;
  }
}

/**
 * Starts the authorization server on an ephemeral loopback port. The returned
 * `url` is the issuer origin, and `signingKey` is what a resource server needs
 * to verify the tokens this instance issues.
 */
export async function startOAuthProvider(options = {}) {
  const subject = options.subject ?? "subject";
  const signingKey = randomBytes(32).toString("base64url");
  /** client_id -> registered redirect URIs. */
  const clients = new Map();
  /** authorization code -> the request it was issued for. */
  const codes = new Map();
  let origin = "";

  const metadata = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });

  async function handleRegister(request, response) {
    const body = await readBody(request);
    let clientMetadata;
    try {
      clientMetadata = body === null ? null : JSON.parse(body);
    } catch {
      clientMetadata = null;
    }
    const redirectUris = clientMetadata?.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 4 ||
      !redirectUris.every((uri) => typeof uri === "string" && URL.canParse(uri))
    ) {
      sendJson(response, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must list one to four absolute URIs.",
      });
      return;
    }
    const clientId = `client-${randomBytes(9).toString("base64url")}`;
    clients.set(clientId, { redirectUris });
    // No client_secret: the MCP client is public and authenticates with PKCE.
    sendJson(
      response,
      201,
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      { "cache-control": "no-store" },
    );
  }

  function handleAuthorize(url, response) {
    const params = url.searchParams;
    const clientId = params.get("client_id");
    const client = clientId === null ? undefined : clients.get(clientId);
    if (client === undefined) {
      sendOAuthError(response, 400, "invalid_client", "Unknown client_id.");
      return;
    }
    const redirectUri = params.get("redirect_uri");
    if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
      // RFC 6749 4.1.2.1: an unverified redirect_uri must never be redirected to.
      sendOAuthError(
        response,
        400,
        "invalid_request",
        "redirect_uri is not registered for this client.",
      );
      return;
    }

    const state = params.get("state");
    const redirect = (entries) => {
      const target = new URL(redirectUri);
      for (const [name, value] of entries) target.searchParams.set(name, value);
      if (state !== null) target.searchParams.set("state", state);
      response.writeHead(302, { location: target.href });
      response.end();
    };
    const fail = (error, description) =>
      redirect([
        ["error", error],
        ["error_description", description],
      ]);

    if (params.get("response_type") !== "code") {
      fail("unsupported_response_type", "Only the code response type exists.");
      return;
    }
    if (state === null) {
      fail("invalid_request", "state is required.");
      return;
    }
    if (params.get("code_challenge_method") !== "S256") {
      fail("invalid_request", "Only the S256 code challenge method exists.");
      return;
    }
    const challenge = params.get("code_challenge");
    if (challenge === null || !PKCE_VALUE.test(challenge)) {
      fail("invalid_request", "code_challenge is missing or malformed.");
      return;
    }
    const resource = params.get("resource");
    if (resource === null || !isValidResource(resource)) {
      fail(
        "invalid_target",
        "resource must be an absolute URI without a fragment.",
      );
      return;
    }

    for (const [issued, grant] of codes) {
      if (grant.expiresAt <= Date.now()) codes.delete(issued);
    }
    if (codes.size >= MAX_OUTSTANDING_CODES) {
      fail(
        "temporarily_unavailable",
        "Too many outstanding authorization codes.",
      );
      return;
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId,
      redirectUri,
      challenge,
      resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    redirect([["code", code]]);
  }

  async function handleToken(request, response) {
    if (!isFormUrlEncoded(request.headers["content-type"])) {
      sendOAuthError(
        response,
        400,
        "invalid_request",
        "The token request must be form-urlencoded.",
      );
      return;
    }
    const body = await readBody(request);
    if (body === null) {
      sendOAuthError(
        response,
        400,
        "invalid_request",
        "The request body is too large.",
      );
      return;
    }
    const params = new URLSearchParams(body);
    if (params.get("grant_type") !== "authorization_code") {
      sendOAuthError(
        response,
        400,
        "unsupported_grant_type",
        "Only the authorization_code grant exists.",
      );
      return;
    }
    const code = params.get("code");
    const grant = code === null ? undefined : codes.get(code);
    if (code === null || grant === undefined) {
      sendOAuthError(
        response,
        400,
        "invalid_grant",
        "Unknown, expired, or already redeemed authorization code.",
      );
      return;
    }
    // One exchange attempt per code, successful or not.
    codes.delete(code);
    if (grant.expiresAt <= Date.now()) {
      sendOAuthError(
        response,
        400,
        "invalid_grant",
        "The authorization code expired.",
      );
      return;
    }
    if (params.get("client_id") !== grant.clientId) {
      sendOAuthError(
        response,
        400,
        "invalid_client",
        "client_id does not match the authorization code.",
      );
      return;
    }
    if (params.get("redirect_uri") !== grant.redirectUri) {
      sendOAuthError(
        response,
        400,
        "invalid_grant",
        "redirect_uri does not match the authorization code.",
      );
      return;
    }
    const verifier = params.get("code_verifier");
    if (
      verifier === null ||
      !PKCE_VALUE.test(verifier) ||
      !equalStrings(
        createHash("sha256").update(verifier, "ascii").digest("base64url"),
        grant.challenge,
      )
    ) {
      sendOAuthError(
        response,
        400,
        "invalid_grant",
        "code_verifier does not match the code_challenge.",
      );
      return;
    }
    const resource = params.get("resource");
    if (resource !== null && resource !== grant.resource) {
      sendOAuthError(
        response,
        400,
        "invalid_target",
        "resource does not match the authorization request.",
      );
      return;
    }

    sendJson(
      response,
      200,
      {
        access_token: signAccessToken(
          {
            sub: subject,
            aud: grant.resource,
            client_id: grant.clientId,
            exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
            jti: randomBytes(12).toString("base64url"),
          },
          signingKey,
        ),
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
      },
      { "cache-control": "no-store" },
    );
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      const method = request.method ?? "GET";
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (method !== "GET") {
          sendOAuthError(response, 405, "invalid_request", "Use GET.");
          return;
        }
        sendJson(response, 200, metadata());
        return;
      }
      if (url.pathname === "/register") {
        if (method !== "POST") {
          sendOAuthError(response, 405, "invalid_request", "Use POST.");
          return;
        }
        await handleRegister(request, response);
        return;
      }
      if (url.pathname === "/authorize") {
        if (method !== "GET") {
          sendOAuthError(response, 405, "invalid_request", "Use GET.");
          return;
        }
        handleAuthorize(url, response);
        return;
      }
      if (url.pathname === "/token") {
        if (method !== "POST") {
          sendOAuthError(response, 405, "invalid_request", "Use POST.");
          return;
        }
        await handleToken(request, response);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch(() => {
      if (!response.headersSent) {
        sendOAuthError(response, 500, "server_error", "The fixture failed.");
      } else {
        response.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${String(server.address().port)}`;

  return {
    url: origin,
    signingKey,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      }),
  };
}
