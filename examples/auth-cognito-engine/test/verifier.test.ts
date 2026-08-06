import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  generateSecret,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { toPrincipal } from "../src/identity/principal.js";
import {
  CognitoVerificationUnavailableError,
  cognitoIssuer,
  cognitoJwksUri,
  createCognitoVerifier,
} from "../src/identity/verifier.js";
import {
  accessTokenClaims,
  appClientId,
  type CognitoTokenFactory,
  createTokenFactory,
  issuer,
  region,
  subject,
  userPoolId,
} from "./cognito-tokens.js";

const signal = new AbortController().signal;

let tokens: CognitoTokenFactory;

function createVerifier(factory: CognitoTokenFactory = tokens) {
  return createCognitoVerifier({
    region,
    userPoolId,
    appClientIds: [appClientId],
    getKey: createLocalJWKSet(factory.jwks),
  });
}

beforeAll(async () => {
  tokens = await createTokenFactory();
});

describe("cognito user pool endpoints", () => {
  it("derives the documented issuer and JWKS URL from the pool", () => {
    expect(cognitoIssuer(region, userPoolId)).toBe(issuer);
    expect(cognitoJwksUri(region, userPoolId).href).toBe(
      `${issuer}/.well-known/jwks.json`,
    );
  });
});

describe("cognito access token verifier", () => {
  it("accepts a valid access token and exposes only safe claims", async () => {
    const token = await tokens.sign(accessTokenClaims());

    const identity = await createVerifier().verify(token, { signal });

    expect(identity).toEqual({
      subject,
      clientId: appClientId,
      scopes: ["engine/invoke", "openid"],
      groups: ["support-engineers"],
    });
  });

  it("keeps the raw token out of the produced principal", async () => {
    const token = await tokens.sign(accessTokenClaims());

    const identity = await createVerifier().verify(token, { signal });
    if (identity === null) throw new Error("Expected a verified identity.");
    const principal = toPrincipal(identity);

    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(token);
    for (const segment of token.split(".")) {
      expect(serialized).not.toContain(segment);
    }
    expect(principal).toEqual({
      id: subject,
      attributes: {
        clientId: appClientId,
        scopes: ["engine/invoke", "openid"],
        groups: ["support-engineers"],
      },
    });
    expect(() => structuredClone(principal)).not.toThrow();
  });

  it("returns null for a malformed token", async () => {
    await expect(
      createVerifier().verify("not-a-jwt", { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await tokens.sign(
      accessTokenClaims({ iat: now - 7_200, exp: now - 60 }),
    );

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for another user pool issuer", async () => {
    const token = await tokens.sign(
      accessTokenClaims({
        iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool",
      }),
    );

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for another app client id", async () => {
    const token = await tokens.sign(
      accessTokenClaims({ client_id: "9other87654321" }),
    );

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null when the client_id claim is missing", async () => {
    const claims = accessTokenClaims();
    delete claims.client_id;

    await expect(
      createVerifier().verify(await tokens.sign(claims), { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for an id token presented as an access token", async () => {
    const token = await tokens.sign(
      accessTokenClaims({
        token_use: "id",
        aud: appClientId,
      }),
    );

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for a token signed by a foreign key", async () => {
    const foreign = await createTokenFactory();
    const token = await foreign.sign(accessTokenClaims());

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for a token signed by an unknown key id", async () => {
    const foreign = await createTokenFactory("rotated-key");
    const token = await foreign.sign(accessTokenClaims());

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for a signed token without an expiry", async () => {
    const claims = accessTokenClaims();
    delete claims.exp;

    await expect(
      createVerifier().verify(await tokens.sign(claims), { signal }),
    ).resolves.toBeNull();
  });

  it("returns null for a token signed outside the algorithm allowlist", async () => {
    // Pins algorithms: ["RS256"] — an HS256 token must never verify, even
    // with otherwise perfect claims.
    const secret = await generateSecret("HS256", { extractable: true });
    const token = await new SignJWT(accessTokenClaims())
      .setProtectedHeader({ alg: "HS256" })
      .sign(secret);

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("returns null when the subject claim is missing", async () => {
    const claims = accessTokenClaims();
    delete claims.sub;

    await expect(
      createVerifier().verify(await tokens.sign(claims), { signal }),
    ).resolves.toBeNull();
  });

  it("returns null when cognito:groups is not a list of strings", async () => {
    const token = await tokens.sign(
      accessTokenClaims({ "cognito:groups": "support-engineers" }),
    );

    await expect(
      createVerifier().verify(token, { signal }),
    ).resolves.toBeNull();
  });

  it("treats an absent cognito:groups claim as no groups", async () => {
    const claims = accessTokenClaims();
    delete claims["cognito:groups"];

    await expect(
      createVerifier().verify(await tokens.sign(claims), { signal }),
    ).resolves.toMatchObject({ groups: [] });
  });

  it("throws when the key set is ambiguous for the token", async () => {
    // Two same-algorithm keys without kid headers: jose cannot pick a
    // candidate, which is the pool's key-publication problem, not proof
    // against the credential — so it surfaces as unavailable, not null.
    const first = await generateKeyPair("RS256", { extractable: true });
    const second = await generateKeyPair("RS256", { extractable: true });
    const ambiguous = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(first.publicKey)), alg: "RS256", use: "sig" },
        { ...(await exportJWK(second.publicKey)), alg: "RS256", use: "sig" },
      ],
    });
    const verifier = createCognitoVerifier({
      region,
      userPoolId,
      appClientIds: [appClientId],
      getKey: ambiguous,
    });
    const token = await new SignJWT(accessTokenClaims())
      .setProtectedHeader({ alg: "RS256" })
      .sign(first.privateKey);

    await expect(verifier.verify(token, { signal })).rejects.toBeInstanceOf(
      CognitoVerificationUnavailableError,
    );
  });

  it("throws a sanitized error when key resolution is unavailable", async () => {
    const verifier = createCognitoVerifier({
      region,
      userPoolId,
      appClientIds: [appClientId],
      getKey: () => Promise.reject(new errors.JWKSTimeout()),
    });
    const token = await tokens.sign(accessTokenClaims());

    const rejection = verifier.verify(token, { signal });

    await expect(rejection).rejects.toBeInstanceOf(
      CognitoVerificationUnavailableError,
    );
    await expect(rejection).rejects.toMatchObject({
      message: "Cognito token verification is unavailable.",
    });
    await rejection.catch((error: unknown) => {
      expect(JSON.stringify((error as Error).message)).not.toContain(token);
    });
  });

  it("stops waiting when the request is aborted", async () => {
    const controller = new AbortController();
    const verifier = createCognitoVerifier({
      region,
      userPoolId,
      appClientIds: [appClientId],
      getKey: () => new Promise(() => undefined),
    });
    const token = await tokens.sign(accessTokenClaims());

    const rejection = verifier.verify(token, { signal: controller.signal });
    controller.abort();

    await expect(rejection).rejects.toBeInstanceOf(
      CognitoVerificationUnavailableError,
    );
  });

  it("rejects a configuration without an app client id", () => {
    expect(() =>
      createCognitoVerifier({
        region,
        userPoolId,
        appClientIds: [],
      }),
    ).toThrow(/app client/iu);
  });
});
