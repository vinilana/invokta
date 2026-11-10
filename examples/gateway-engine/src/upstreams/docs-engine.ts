import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

const articles = Object.freeze([
  {
    slug: "refund-policy",
    title: "Refund policy",
    body: "Paid invoices can be refunded in full within 30 days.",
  },
  {
    slug: "reset-password",
    title: "Reset a password",
    body: "Send the customer the password reset link from the account page.",
  },
  {
    slug: "escalation",
    title: "Escalate a ticket",
    body: "Escalate billing tickets above 1,000 dollars to finance.",
  },
]);

/**
 * The documentation team's Action Engine. In this example it stands in for
 * a remote MCP server owned by another team: `docs-mcp-http.ts` serves it,
 * and the gateway reaches it only over MCP with a service token.
 */
export function createDocsEngine() {
  return createEngine({
    name: "docs-engine",
    version: "4.1.0",
    capabilities: {
      "docs.search": defineCapability({
        title: "Search the knowledge base",
        description: "Search support articles by keyword.",
        input: z.object({ query: z.string().min(1).max(200) }),
        output: z.object({
          articles: z.array(
            z.object({ slug: z.string(), title: z.string(), body: z.string() }),
          ),
        }),
        access: "authenticated",
        annotations: { readOnly: true, openWorld: false },
        async run({ input }) {
          const words = input.query.toLowerCase().split(/\s+/u);
          return {
            articles: articles.filter((article) =>
              words.some((word) =>
                `${article.title} ${article.body}`.toLowerCase().includes(word),
              ),
            ),
          };
        },
      }),
    },
  });
}
