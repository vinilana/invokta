import type { CrawlPermissionChecker } from "../application/ports.js";

function stringArray(value: unknown): ReadonlyArray<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function hostMatches(host: string, allowedHost: string): boolean {
  const allowed = allowedHost.toLowerCase();
  return allowed !== "" && (host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Reads the crawl permissions and the host allowlist from trusted principal
 * attributes. A malformed constraint denies the request.
 */
export function createAttributeCrawlPermissionChecker(): CrawlPermissionChecker {
  return {
    can(principal, permission, target) {
      const permissions = stringArray(principal.attributes?.permissions);
      if (permissions?.includes(permission) !== true) return false;

      const constraint = principal.attributes?.allowedHosts;
      if (constraint === undefined) return true;
      const allowedHosts = stringArray(constraint);
      return (
        allowedHosts?.some((allowedHost) =>
          hostMatches(target.host, allowedHost),
        ) === true
      );
    },
  };
}
