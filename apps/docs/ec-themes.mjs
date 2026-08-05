/**
 * Expressive Code themes for the Invokta docs.
 *
 * These are plain VS Code theme objects carrying the exact Night Owl and
 * Night Owl Light palettes from the landing page's `--code-*` tokens, plus
 * chrome colours taken from the `--ink-*` surfaces so the code frame is built
 * from the same hairlines as everything else.
 *
 * The values are literal hex rather than `var(--code-*)` because Expressive
 * Code has to parse them at build time. They are kept in lockstep with
 * `src/styles/tokens.css` — change both together.
 */

/** Night Owl (dark). */
const darkSyntax = {
  plain: "#d6deeb",
  comment: "#7a8b99",
  keyword: "#c792ea",
  string: "#ecc48d",
  fn: "#82aaff",
  number: "#f78c6c",
  prop: "#7fdbca",
  punct: "#8b96a5",
};

/** Night Owl Light. */
const lightSyntax = {
  plain: "#403f53",
  comment: "#6b7280",
  keyword: "#8844ae",
  string: "#984e4d",
  fn: "#3b61b0",
  number: "#aa0982",
  prop: "#096e72",
  punct: "#6b7280",
};

/**
 * Maps the eight syntax roles onto TextMate scopes.
 *
 * The role split is the one the landing page's highlighter uses:
 * comments are additionally italic, JSON/JS literals (`true`/`false`/`null`)
 * and shell flags count as keywords, the leading word of a shell line and any
 * identifier followed by `(` count as functions, and object keys plus `$VAR`
 * count as properties.
 */
function tokenColors(c) {
  return [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: c.comment, fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "keyword.control",
        "keyword.other",
        "keyword.operator.new",
        "keyword.operator.expression",
        "storage",
        "storage.type",
        "storage.modifier",
        "variable.language",
        "constant.language",
        "support.type.primitive",
        "entity.name.tag",
        "entity.name.type",
        "support.class",
        "support.type",
        "constant.other.option",
      ],
      settings: { foreground: c.keyword },
    },
    {
      scope: [
        "string",
        "string.quoted",
        "string.template",
        "punctuation.definition.string",
        "constant.other.symbol",
      ],
      settings: { foreground: c.string },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "variable.function",
        "meta.function-call.generic",
        "entity.name.command",
        "support.function.builtin",
      ],
      settings: { foreground: c.fn },
    },
    {
      scope: ["constant.numeric", "constant.character", "keyword.other.unit"],
      settings: { foreground: c.number },
    },
    {
      scope: [
        "variable.other.property",
        "support.type.property-name",
        "meta.object-literal.key",
        "entity.name.tag.yaml",
        "entity.other.attribute-name",
        "support.variable",
        "variable.other.constant",
        "variable.other.normal",
        "punctuation.definition.variable",
      ],
      settings: { foreground: c.prop },
    },
    {
      scope: [
        "punctuation",
        "punctuation.separator",
        "punctuation.terminator",
        "punctuation.accessor",
        "meta.brace",
        "keyword.operator",
      ],
      settings: { foreground: c.punct },
    },
  ];
}

/**
 * Frame chrome. `surface` is the recessed code plate, `raised` the active
 * tab, `line` the hairline and `accent` the 1px tab underline.
 */
function frameColors({ surface, raised, line, fg, body, faint, accent, low }) {
  return {
    "editor.background": surface,
    "editor.selectionBackground": low,
    "editorLineNumber.foreground": faint,
    "editorLineNumber.activeForeground": body,
    "editorGroupHeader.tabsBackground": surface,
    "editorGroupHeader.tabsBorder": line,
    "tab.activeBackground": raised,
    "tab.activeForeground": fg,
    "tab.inactiveBackground": surface,
    "tab.inactiveForeground": body,
    "tab.border": line,
    /* Fully transparent hex: theme colours are parsed, so keywords like
       `transparent` are rejected here. */
    "tab.activeBorder": "#00000000",
    "tab.activeBorderTop": accent,
    "titleBar.activeBackground": surface,
    "titleBar.activeForeground": body,
    "titleBar.border": line,
    "panel.border": line,
    "terminal.background": surface,
    "scrollbarSlider.background": line,
    "scrollbarSlider.hoverBackground": faint,
    focusBorder: accent,
  };
}

export const invoktaCodeDark = {
  name: "invokta-dark",
  type: "dark",
  colors: {
    ...frameColors({
      surface: "#0e0e11",
      raised: "#18181b",
      line: "#27272a",
      fg: "#fafafa",
      body: "#a1a1aa",
      faint: "#71717a",
      accent: "#3369ff",
      low: "#16224a",
    }),
    "editor.foreground": darkSyntax.plain,
    "terminal.foreground": darkSyntax.plain,
  },
  tokenColors: tokenColors(darkSyntax),
};

export const invoktaCodeLight = {
  name: "invokta-light",
  type: "light",
  colors: {
    ...frameColors({
      surface: "#fafafa",
      raised: "#ffffff",
      line: "#e4e4e7",
      fg: "#18181b",
      body: "#71717a",
      faint: "#a1a1aa",
      accent: "#3d50f5",
      low: "#eaecfe",
    }),
    "editor.foreground": lightSyntax.plain,
    "terminal.foreground": lightSyntax.plain,
  },
  tokenColors: tokenColors(lightSyntax),
};
