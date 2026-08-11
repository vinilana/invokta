import type { Principal } from "@invokta/core";

export function localPrincipal(): Principal {
  return { id: process.env.APP_PRINCIPAL_ID?.trim() || "local:user" };
}
