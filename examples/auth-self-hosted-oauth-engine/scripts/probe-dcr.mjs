const argumentIndex = process.argv.indexOf("--url");
const rawUrl = argumentIndex < 0 ? undefined : process.argv[argumentIndex + 1];
if (!rawUrl) {
  throw new Error(
    "Usage: npm run oauth:probe-dcr -- --url https://mcp.example.com",
  );
}

const origin = new URL(rawUrl);
const loopback =
  origin.hostname === "localhost" ||
  origin.hostname === "127.0.0.1" ||
  origin.hostname === "[::1]";
if (
  origin.protocol !== "https:" &&
  !(origin.protocol === "http:" && loopback)
) {
  throw new Error(
    "The probe URL must use HTTPS except for loopback development.",
  );
}
if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
  throw new Error(
    "The probe URL must be an origin without a path, query, or fragment.",
  );
}

const response = await fetch(new URL("/reg", origin), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "OAuth template DCR probe",
    redirect_uris: [new URL("/oauth-dcr-probe-callback", origin).href],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "openid offline_access mcp:tools",
  }),
});
const raw = await response.text();
if (!response.ok) {
  throw new Error(`Dynamic registration failed with HTTP ${response.status}.`);
}
const client = JSON.parse(raw);

let validationFailure;
try {
  const result = {
    status: response.status,
    hasClientId: typeof client.client_id === "string",
    hasClientSecret: typeof client.client_secret === "string",
    tokenEndpointAuthMethod: client.token_endpoint_auth_method,
    idTokenSignedResponseAlg: client.id_token_signed_response_alg,
  };
  if (
    !result.hasClientId ||
    !result.hasClientSecret ||
    result.tokenEndpointAuthMethod !== "client_secret_basic" ||
    result.idTokenSignedResponseAlg !== "ES256"
  ) {
    throw new Error("Dynamic registration returned unexpected safe metadata.");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  validationFailure = error;
}

if (client.registration_client_uri && client.registration_access_token) {
  const registrationClientUrl = new URL(client.registration_client_uri);
  if (registrationClientUrl.origin !== origin.origin) {
    throw new Error("Temporary client cleanup URL has an unexpected origin.");
  }
  const cleanup = await fetch(registrationClientUrl, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${client.registration_access_token}`,
    },
  });
  if (!cleanup.ok && cleanup.status !== 204) {
    throw new Error(
      `Temporary client cleanup failed with HTTP ${cleanup.status}.`,
    );
  }
  process.stdout.write(`Temporary client cleanup: ${cleanup.status}\n`);
}

if (validationFailure !== undefined) throw validationFailure;
