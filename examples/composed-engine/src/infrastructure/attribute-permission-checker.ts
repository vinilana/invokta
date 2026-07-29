import type { PermissionChecker } from "@invokta/example-community-capabilities";

function stringArray(value: unknown): ReadonlyArray<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export function createAttributePermissionChecker(): PermissionChecker {
  return {
    can(principal, permission, resourceId) {
      const permissions = stringArray(principal.attributes?.permissions);
      if (permissions?.includes(permission) !== true) return false;
      if (!permission.startsWith("ticket:")) return true;

      const resourceConstraint = principal.attributes?.allowedTicketIds;
      if (resourceConstraint === undefined) return true;
      const allowedTicketIds = stringArray(resourceConstraint);
      return allowedTicketIds?.includes(resourceId) === true;
    },
  };
}
