import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { invoktaCodeDark, invoktaCodeLight } from "./ec-themes.mjs";

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
        "Build repeatable AI-assisted tasks once and invoke them from any agent, CLI, or application.",
      favicon: "/favicon.svg",
      /*
       * The brand mark is not declared through `logo` because Starlight would
       * emit it as `<img src>`, and an external image cannot resolve the
       * `--accent-text` / `--ink-fg` custom properties the mark is drawn
       * with. `components.SiteTitle` inlines the same SVG instead, so the
       * mark follows the theme toggle.
       */
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
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
      // Ordered: font faces, then design tokens, then component surfaces.
      customCss: [
        "./src/styles/fonts.css",
        "./src/styles/tokens.css",
        "./src/styles/global.css",
      ],
      expressiveCode: {
        themes: [invoktaCodeDark, invoktaCodeLight],
        /*
         * The themes above already carry the frame colours, so Starlight's
         * `--sl-color-*` overlay is switched off — otherwise it rewrites
         * `theme.bg` for contrast maths and shifts the Night Owl palette.
         * A contrast floor of 0 keeps every syntax colour exact.
         */
        useStarlightUiThemeColors: false,
        minSyntaxHighlightingColorContrast: 0,
        styleOverrides: {
          borderRadius: "0.375rem",
          borderWidth: "1px",
          codeFontFamily: "var(--__sl-font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.7",
          codePaddingBlock: "0.875rem",
          codePaddingInline: "1rem",
          uiFontFamily: "var(--__sl-font-mono)",
          uiFontSize: "0.75rem",
          frames: {
            frameBoxShadowCssValue: "none",
            editorTabBorderRadius: "0",
            editorTabsMarginInlineStart: "0",
            editorTabsMarginBlockStart: "0",
            editorActiveTabIndicatorHeight: "1px",
            terminalTitlebarDotsOpacity: "0.6",
          },
        },
      },
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#09090b" },
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
        { label: "Use cases", slug: "use-cases" },
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
            {
              label: "Authentication",
              items: [
                { slug: "recipes/auth" },
                { slug: "recipes/auth/jwt-bearer" },
                { slug: "recipes/auth/supabase" },
                { slug: "recipes/auth/clerk" },
                { slug: "recipes/auth/auth0" },
                { slug: "recipes/auth/cognito" },
                { slug: "recipes/auth/firebase" },
                { slug: "recipes/auth/better-auth" },
                { slug: "recipes/auth/authjs" },
                { slug: "recipes/auth/workos" },
                { slug: "recipes/auth/api-key" },
                { slug: "recipes/auth/mcp-oauth-discovery" },
                { slug: "recipes/auth/self-hosted-oauth" },
              ],
            },
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
            { slug: "reference/devtools" },
            { slug: "reference/installer" },
            { slug: "reference/deploy" },
            { slug: "reference/create-invokta-engine" },
            { slug: "reference/create-invokta-capability" },
            { slug: "reference/create-invokta-capability-library" },
            { slug: "reference/errors" },
          ],
        },
      ],
    }),
  ],
});
