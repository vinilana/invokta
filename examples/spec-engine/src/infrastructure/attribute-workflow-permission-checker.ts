import type { WorkflowPermissionChecker } from "../application/ports.js";

function stringArray(value: unknown): ReadonlyArray<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

/**
 * Reads workflow permissions, and an optional specification allowlist, from
 * trusted principal attributes. A malformed constraint denies the request.
 */
export function createAttributeWorkflowPermissionChecker(): WorkflowPermissionChecker {
  return {
    can(principal, permission, specId) {
      const permissions = stringArray(principal.attributes?.permissions);
      if (permissions?.includes(permission) !== true) return false;

      const constraint = principal.attributes?.allowedSpecIds;
      if (constraint === undefined) return true;
      const allowedSpecIds = stringArray(constraint);
      return allowedSpecIds?.includes(specId) === true;
    },
  };
}
