import {
  type AnyCapability,
  createEngine,
  defineCapability,
} from "@invokta/core";
import { z } from "zod";

/** The twenty record types of the vendor's CRM, grouped by area. */
export const crmObjects = Object.freeze([
  ["billing", "invoice"],
  ["billing", "subscription"],
  ["accounts", "customer"],
  ["accounts", "account"],
  ["orders", "order"],
  ["logistics", "shipment"],
  ["service", "ticket"],
  ["catalog", "product"],
  ["warehouse", "stock-item"],
  ["payments", "payment"],
  ["legal", "contract"],
  ["people", "employee"],
  ["projects", "project"],
  ["files", "document"],
  ["analytics", "report"],
  ["marketing", "campaign"],
  ["sales", "lead"],
  ["procurement", "vendor"],
  ["assets", "asset"],
  ["calendar", "meeting"],
] as const);

/** The ten operations every record type supports, and whether they only read. */
export const crmActions = Object.freeze([
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
] as const);

/**
 * A stand-in for a vendor's CRM MCP server: 200 tools, one per operation and
 * record type, the shape of a server that mirrors an API endpoint by
 * endpoint. `crm-mcp-http.ts` serves it; the gateway reaches it only over MCP.
 */
export function createCrmEngine() {
  const capabilities: Record<string, AnyCapability> = {};
  for (const [area, object] of crmObjects) {
    for (const [action, template, readOnly] of crmActions) {
      const label = object.replaceAll("-", " ");
      capabilities[`${area}.${action}-${object}`] = defineCapability({
        description: template.replaceAll("{object}", label),
        input: z.object({
          id: z.string().max(64).optional(),
          fields: z.record(z.string(), z.string().max(500)).optional(),
        }),
        output: z.object({
          ok: z.boolean(),
          operation: z.string(),
          record: z.string(),
        }),
        access: "authenticated",
        annotations: readOnly
          ? { readOnly: true, openWorld: false }
          : { readOnly: false, destructive: action !== "create" },
        async run() {
          return { ok: true, operation: action, record: object };
        },
      }) as unknown as AnyCapability;
    }
  }
  return createEngine({
    name: "vendor-crm",
    version: "7.2.0",
    capabilities,
  });
}
