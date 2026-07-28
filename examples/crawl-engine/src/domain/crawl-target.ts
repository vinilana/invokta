export interface CrawlTarget {
  readonly url: string;
  readonly host: string;
}

const blockedHostSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
] as const;

function parseIpv4(host: string): ReadonlyArray<number> | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function isReservedIpv4(octets: ReadonlyArray<number>): boolean {
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  );
}

function isReservedIpv6(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const address = host.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address)?.[1];
  if (mapped !== undefined) {
    const octets = parseIpv4(mapped);
    return octets === null || isReservedIpv4(octets);
  }
  return (
    address === "::" ||
    address === "::1" ||
    /^f[cd]/u.test(address) ||
    /^fe[89ab]/u.test(address)
  );
}

/**
 * Accepts only a public, credential-free `http` or `https` address. Loopback,
 * link-local, private, and reserved hosts are rejected so a crawl request
 * cannot be turned into a request against the deployment's own network.
 */
export function parseCrawlTarget(rawUrl: string): CrawlTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;

  const host = url.hostname.toLowerCase();
  if (host === "" || host === "localhost") return null;
  if (blockedHostSuffixes.some((suffix) => host.endsWith(suffix))) return null;
  const octets = parseIpv4(host);
  if (octets !== null && isReservedIpv4(octets)) return null;
  if (isReservedIpv6(host)) return null;

  return { url: url.toString(), host };
}
