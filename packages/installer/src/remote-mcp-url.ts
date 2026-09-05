/** One offline URL contract for remote sources, registry, managed state, and adapters. */
export type RemoteMcpUrlIssue =
  | "INVALID_URL"
  | "CREDENTIAL_URL"
  | "INSECURE_URL";

export interface RemoteMcpUrlValidation {
  readonly url: string | undefined;
  readonly issues: readonly RemoteMcpUrlIssue[];
}

/** ADRs 0039 and 0040: unreserved ASCII segments, at most 256 bytes, ending in mcp. */
function canonicalPath(value: string): boolean {
  if (value.length > 256 || !value.startsWith("/")) return false;
  const segments = value.slice(1).split("/");
  return (
    segments.at(-1) === "mcp" &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9._~-]+$/u.test(segment) &&
        segment !== "." &&
        segment !== "..",
    )
  );
}

function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127 || character === "\\") return true;
  }
  return false;
}

export function validateRemoteMcpUrl(value: string): RemoteMcpUrlValidation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { url: undefined, issues: ["INVALID_URL"] };
  }
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return { url: undefined, issues: ["INVALID_URL"] };
  const authorityTail = value.slice(schemeSeparator + 3);
  const authorityEnd = authorityTail.search(/[/?#]/u);
  const authority = authorityTail.slice(
    0,
    authorityEnd === -1 ? undefined : authorityEnd,
  );
  const rawTarget =
    authorityEnd === -1 ? "" : authorityTail.slice(authorityEnd);
  const queryOrFragment = rawTarget.search(/[?#]/u);
  const rawPath = rawTarget.slice(
    0,
    queryOrFragment === -1 ? undefined : queryOrFragment,
  );
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":", 1)[0];
  const issues: RemoteMcpUrlIssue[] = [];
  if (authority.includes("@") || url.username !== "" || url.password !== "")
    issues.push("CREDENTIAL_URL");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    authority === "" ||
    url.hostname === "" ||
    !canonicalPath(rawPath) ||
    url.pathname !== rawPath ||
    hasUnsafeCharacters(value) ||
    value.includes("?") ||
    value.includes("#")
  )
    issues.push("INVALID_URL");
  if (
    url.protocol === "http:" &&
    rawHost !== "127.0.0.1" &&
    rawHost !== "[::1]"
  )
    issues.push("INSECURE_URL");
  return { url: issues.length === 0 ? url.href : undefined, issues };
}
