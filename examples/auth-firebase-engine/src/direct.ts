/**
 * Embedded surface: a host that already verified a Firebase ID token.
 *
 * A Next.js route handler, a Cloud Function, or any server that already ran
 * `getAuth().verifyIdToken()` holds the decoded claims. It maps them once and
 * invokes the engine directly, with no HTTP boundary in between. This script
 * starts from a sample claim set — no credential exists here, and no
 * verification is skipped: verification happened before this point.
 */
import { pathToFileURL } from "node:url";

import { engine } from "./engine.js";
import { firebaseIssuer, toPrincipal } from "./identity/principal.js";
import type { FirebaseIdTokenClaims } from "./identity/verifier.js";

const projectId = "demo-invokta-engine";

const verifiedClaims: FirebaseIdTokenClaims = {
  iss: firebaseIssuer(projectId),
  aud: projectId,
  sub: "uid-demo-1",
  email: "ada@example.com",
  email_verified: true,
  auth_time: 1_754_400_000,
  firebase: { sign_in_provider: "password" },
  role: "support-agent",
};

export async function main(): Promise<void> {
  const principal = toPrincipal(verifiedClaims, {
    projectId,
    customClaimNames: ["role"],
  });
  if (principal === null) {
    throw new Error("The sample claims are not valid for this project.");
  }

  const result = await engine.invoke(
    "identity.whoami",
    {},
    { source: "direct", principal },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Firebase example direct invocation failed.\n");
    process.exitCode = 1;
  });
}
