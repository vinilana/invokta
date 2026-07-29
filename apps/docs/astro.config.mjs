import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const site = (process.env.DOCS_SITE_URL ?? "https://docs.invokta.dev").replace(
  /\/$/,
  "",
);

export default defineConfig({
  site,
  integrations: [
    starlight({
      title: "Invokta",
      description:
        "Define typed domain capabilities once and invoke them directly, through a CLI, or over MCP.",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/invokta-mark.svg",
        alt: "Invokta",
      },
      social: [
        {
          icon: "github",
          label: "Invokta on GitHub",
          href: "https://github.com/vinilana/ai-engines",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/vinilana/ai-engines/edit/main/apps/docs/",
      },
      lastUpdated: true,
      customCss: ["./src/styles/global.css"],
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#0a0a0a" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: `${site}/og.svg`,
          },
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        {
          label: "Getting started",
          items: [
            { slug: "getting-started/installation" },
            { slug: "getting-started/first-engine" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/action-engines" },
            { slug: "concepts/capabilities" },
            { slug: "concepts/invocation-pipeline" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/execution-channels" },
            { slug: "guides/deployment" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/core" },
            { slug: "reference/cli" },
            { slug: "reference/mcp" },
            { slug: "reference/errors" },
          ],
        },
      ],
    }),
  ],
});
