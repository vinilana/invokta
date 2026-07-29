import type { Principal } from "@invokta/core";

export type AgentSessionPermission =
  | "agent-session:read"
  | "agent-session:write"
  | "agent-session:hooks";

export function hasPermission(
  principal: Principal | null,
  permission: AgentSessionPermission,
): boolean {
  if (principal === null) return false;
  const permissions = principal.attributes?.permissions;
  return (
    Array.isArray(permissions) &&
    permissions.some((candidate) => candidate === permission)
  );
}
