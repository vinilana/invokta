import {
  type AnyCapability,
  createEngine,
  defineCapability,
} from "@invokta/core";
import { z } from "zod";

/** Twenty business objects, each owned by one namespace. */
export const objects = [
  ["billing", "invoice"],
  ["crm", "customer"],
  ["orders", "order"],
  ["logistics", "shipment"],
  ["support", "ticket"],
  ["catalog", "product"],
  ["warehouse", "inventory-item"],
  ["payments", "payment"],
  ["billing", "subscription"],
  ["legal", "contract"],
  ["hr", "employee"],
  ["projects", "project"],
  ["docs", "document"],
  ["reporting", "report"],
  ["marketing", "campaign"],
  ["sales", "lead"],
  ["crm", "account"],
  ["procurement", "vendor"],
  ["it", "asset"],
  ["calendar", "meeting"],
] as const;

/** Ten actions, their description template, and whether they are reads. */
export const actions = [
  ["create", "Create a new {object} record.", false],
  ["update", "Update the fields of an existing {object}.", false],
  ["delete", "Permanently delete one {object}.", false],
  ["get", "Return one {object} by its identifier.", true],
  ["list", "List {object} records with pagination.", true],
  ["search", "Search {object} records by keyword.", true],
  ["archive", "Archive an {object} so it no longer appears in lists.", false],
  ["export", "Export {object} records as a CSV file.", true],
  ["approve", "Approve a pending {object}.", false],
  ["cancel", "Cancel an {object} that has not completed.", false],
] as const;

/** The capability ID of one action on one object, for example `orders.cancel-order`. */
export function toolId(namespace: string, action: string, object: string) {
  return `${namespace}.${action}-${object}`;
}

/** An engine with 200 capabilities: every action on every object. */
export function createLargeCatalogEngine() {
  const capabilities: Record<string, AnyCapability> = {};
  for (const [namespace, object] of objects) {
    for (const [action, template, read] of actions) {
      const label = object.replaceAll("-", " ");
      capabilities[toolId(namespace, action, object)] = defineCapability({
        description: template.replaceAll("{object}", label),
        input: z.object({ id: z.string().optional() }),
        output: z.object({ ok: z.boolean(), action: z.string() }),
        access: "authenticated",
        annotations: read ? { readOnly: true } : { destructive: true },
        async run() {
          return { ok: true, action };
        },
      }) as unknown as AnyCapability;
    }
  }
  return createEngine({
    name: "large-catalog-engine",
    version: "1.0.0",
    capabilities,
  });
}
