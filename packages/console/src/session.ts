/**
 * The console's authorization boundary.
 *
 * A run mints one 256-bit token and prints it, inside the console URL, to the
 * stream that started the process. Possession of that token is the
 * authorization; the session ends when the process ends. There is no refresh,
 * no persistence, and no second session.
 *
 * The transport rules here exist because a loopback port is reachable by every
 * process and every browser tab on the machine. Pinning the host and the
 * origin, refusing cross-site fetches, and never issuing a cookie together mean
 * a page the operator did not open cannot act on their behalf.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const sessionTokenBytes = 32;

export interface ConsoleSession {
  readonly token: string;
  readonly matches: (candidate: unknown) => boolean;
}

export function createConsoleSession(
  generate: (size: number) => Buffer = randomBytes,
): ConsoleSession {
  const token = generate(sessionTokenBytes).toString("base64url");
  const expected = Buffer.from(token);
  return Object.freeze({
    token,
    matches: (candidate: unknown) => {
      if (typeof candidate !== "string") return false;
      const actual = Buffer.from(candidate);
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(expected, actual);
    },
  });
}

export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (.+)$/u.exec(header);
  return match?.[1];
}

/** Loopback names a browser may legitimately put in `Host` for this server. */
export function loopbackHosts(port: number): readonly string[] {
  const suffix = String(port);
  return Object.freeze([
    `127.0.0.1:${suffix}`,
    `localhost:${suffix}`,
    `[::1]:${suffix}`,
  ]);
}

export function acceptableOrigins(port: number): readonly string[] {
  return Object.freeze(loopbackHosts(port).map((host) => `http://${host}`));
}

export type TransportRejection =
  | "host"
  | "origin"
  | "cross-site"
  | "token"
  | undefined;

export interface TransportCheckInput {
  readonly port: number;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
}

/**
 * Header checks that apply to every request, before any token comparison.
 * `Sec-Fetch-Site: none` is what a browser sends for a typed URL, so the
 * document request stays reachable while a cross-site fetch does not.
 */
export function checkTransport(input: TransportCheckInput): TransportRejection {
  if (
    input.host === undefined ||
    !loopbackHosts(input.port).includes(input.host)
  ) {
    return "host";
  }
  if (
    input.origin !== undefined &&
    !acceptableOrigins(input.port).includes(input.origin)
  ) {
    return "origin";
  }
  if (
    input.fetchSite !== undefined &&
    input.fetchSite !== "same-origin" &&
    input.fetchSite !== "none"
  ) {
    return "cross-site";
  }
  return undefined;
}
