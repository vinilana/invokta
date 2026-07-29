import type { Principal } from "@invokta/core";

/**
 * Trusted local configuration. The host allowlist keeps this example's
 * credentials scoped to documentation sites even when the capability contract
 * accepts any public address.
 */
export const localPrincipal: Principal = Object.freeze({
  id: "local:crawl-operator",
  attributes: Object.freeze({
    permissions: Object.freeze(["crawl:scrape", "crawl:map", "crawl:crawl"]),
    allowedHosts: Object.freeze(["example.com", "firecrawl.dev"]),
  }),
});
