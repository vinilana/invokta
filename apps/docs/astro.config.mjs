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
      description: "The TypeScript framework for building Action Engines.",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/invokta-mark.svg",
        alt: "Invokta",
      },
      social: [
        {
          icon: "github",
          label: "Invokta on GitHub",
          href: "https://github.com/vinilana/invokta",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/vinilana/invokta/edit/main/apps/docs/",
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
        { label: "Examples", slug: "examples" },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/action-engines" },
            { slug: "concepts/capabilities" },
            { slug: "concepts/invocation-pipeline" },
            { slug: "concepts/scope-and-limits" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/execution-channels" },
            { slug: "guides/capability-packages" },
            { slug: "guides/file-naming" },
            { slug: "guides/http-authentication" },
            { slug: "guides/capability-authorization" },
            { slug: "guides/deployment" },
          ],
        },
        {
          label: "Recipes",
          items: [
            { slug: "recipes" },
            { slug: "recipes/atomic-capability-export" },
            { slug: "recipes/capability-library" },
            { slug: "recipes/dependency-injection" },
            { slug: "recipes/domain-authorization" },
            { slug: "recipes/capability-composition" },
            { slug: "recipes/mcp-stdio-consumer" },
            { slug: "recipes/external-provider" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference" },
            { slug: "reference/core" },
            { slug: "reference/cli" },
            { slug: "reference/mcp" },
            { slug: "reference/tooling" },
            { slug: "reference/installer" },
            { slug: "reference/deploy" },
            { slug: "reference/errors" },
          ],
        },
      ],
    }),
  ],
});
