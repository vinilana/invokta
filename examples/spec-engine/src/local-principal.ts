import type { Principal } from "@invokta/core";

/**
 * Trusted local configuration. A deployment that separates roles issues
 * narrower principals: an author with `spec:create` and `spec:plan`, an
 * implementer with `spec:implement`, and a reviewer with `spec:read`.
 */
export const localPrincipal: Principal = Object.freeze({
  id: "local:spec-lead",
  attributes: Object.freeze({
    permissions: Object.freeze([
      "spec:create",
      "spec:plan",
      "spec:break-down",
      "spec:implement",
      "spec:read",
    ]),
  }),
});
