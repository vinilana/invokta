import type { PermissionChecker } from "../application/ports.js";

function stringArray(value: unknown): ReadonlyArray<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export function createAttributePermissionChecker(): PermissionChecker {
  return {
    can(principal, permission, ticketId) {
      const permissions = stringArray(principal.attributes?.permissions);
      if (permissions?.includes(permission) !== true) return false;

      const resourceConstraint = principal.attributes?.allowedTicketIds;
      if (resourceConstraint === undefined) return true;
      const allowedTicketIds = stringArray(resourceConstraint);
      return allowedTicketIds?.includes(ticketId) === true;
    },
  };
}
