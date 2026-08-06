export const styles = `
:root,
:root[data-theme="light"] {
  color-scheme: light;

  /* Mirrors ../lp-invokta/src/styles/tokens.css. */
  --ink-bg: #ffffff;
  --ink-surface: #fafafa;
  --ink-surface-2: #f4f4f5;
  --ink-surface-raised: #ffffff;
  --ink-fg: #18181b;
  --ink-body: #52525b;
  --ink-muted: #71717a;
  --ink-faint: #a1a1aa;
  --ink-line: #e4e4e7;
  --ink-grid: #e6e6e9;
  --bg: var(--ink-bg);
  --surface: var(--ink-surface);
  --surface-2: var(--ink-surface-2);
  --raised: var(--ink-surface-raised);
  --fg: var(--ink-fg);
  --body: var(--ink-body);
  --muted: var(--ink-muted);
  --faint: #6b6b76;
  --line: var(--ink-line);
  --line-strong: #d4d4d8;
  --control-line: #85858e;
  --accent: #3d50f5;
  --accent-hover: #2a3ce0;
  --accent-hover-fg: #ffffff;
  --accent-text: #3d50f5;
  --accent-low: #eaecfe;
  --on-accent: #ffffff;
  --success: #0f6b49;
  --success-low: #e5f5ee;
  --warning: #7a4800;
  --warning-low: #fef3c7;
  --danger: #c9364b;
  --danger-low: #fff0f2;
  --header-bg: rgb(255 255 255 / 88%);
  --rail: rgb(230 230 233 / 90%);
  --shadow: 0 1px 2px rgb(24 24 27 / 5%), 0 12px 36px rgb(24 24 27 / 5%);
  --shadow-soft: 0 8px 24px rgb(24 24 27 / 5%);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --ink-bg: #09090b;
  --ink-surface: #0e0e11;
  --ink-surface-2: #18181b;
  --ink-surface-raised: #18181b;
  --ink-fg: #fafafa;
  --ink-body: #a1a1aa;
  --ink-muted: #a1a1aa;
  --ink-faint: #71717a;
  --ink-line: #27272a;
  --ink-grid: #1e1e20;
  --faint: #8f8f99;
  --line-strong: #3f3f46;
  --control-line: #696974;
  --accent: #3369ff;
  --accent-hover: #5a85ff;
  --accent-hover-fg: #09090b;
  --accent-text: #6f93ff;
  --accent-low: #16224a;
  --on-accent: #ffffff;
  --success: #4fd19b;
  --success-low: #102d22;
  --warning: #e7ad4b;
  --warning-low: #342511;
  --danger: #ff7789;
  --danger-low: #391820;
  --header-bg: rgb(9 9 11 / 86%);
  --rail: rgb(30 30 32 / 90%);
  --shadow: 0 1px 2px rgb(0 0 0 / 25%), 0 18px 48px rgb(0 0 0 / 20%);
  --shadow-soft: 0 12px 32px rgb(0 0 0 / 18%);
}

* { box-sizing: border-box; }

html {
  background: var(--bg);
  overflow-x: clip;
  scroll-behavior: smooth;
  -webkit-text-size-adjust: 100%;
}

body {
  min-width: 0;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.875rem;
  line-height: 1.45;
  overflow-x: clip;
  text-rendering: optimizeLegibility;
}

button,
input,
textarea { font: inherit; }

button { -webkit-tap-highlight-color: transparent; }

code,
pre,
textarea.editor,
.badge,
.meta-pill,
.connection-status,
.capability-choice-id {
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono",
    monospace;
}

h1,
h2,
h3,
h4,
p { margin-top: 0; }

h1,
h2,
h3,
h4 {
  color: var(--fg);
  font-weight: 620;
  letter-spacing: -0.025em;
}

h2 { font-size: 1.15rem; }
h3 { font-size: 0.95rem; }
h4 { font-size: 0.75rem; }

::selection {
  background: var(--accent-low);
  color: var(--fg);
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}

button:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible,
[role="tabpanel"]:focus-visible,
[role="region"]:focus-visible,
.principal-row:focus-visible,
.principals-panel-body > h2:focus-visible {
  outline: 2px solid var(--accent-text);
  outline-offset: 2px;
}

button:disabled {
  cursor: wait !important;
  opacity: 0.55;
}

.app-shell {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  isolation: isolate;
}

.blueprint-rails {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.blueprint-rails span {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--rail);
}

.blueprint-rails span:nth-child(1) { left: 9.2%; }
.blueprint-rails span:nth-child(2) { left: 20.5%; }
.blueprint-rails span:nth-child(3) { left: 52.6%; }
.blueprint-rails span:nth-child(4) { left: 84.5%; }
.blueprint-rails span:nth-child(5) { left: 95.8%; }

.content-frame {
  width: min(calc(100% - 1.5rem), 90rem);
  margin-inline: auto;
}

header.app {
  position: sticky;
  top: 0;
  z-index: 20;
  min-height: 2.75rem;
  border-bottom: 1px solid var(--line);
  background: var(--header-bg);
  backdrop-filter: blur(18px) saturate(140%);
}

.topbar-inner {
  min-height: 2.75rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.brand-lockup {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.45rem;
  min-width: max-content;
}

.brand-mark {
  display: block;
  flex: 0 0 auto;
  width: 1.5rem;
  height: auto;
}

.brand-name {
  font-size: 0.95rem;
  font-weight: 680;
  letter-spacing: -0.035em;
}

.product-name {
  margin-left: 0.15rem;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.2;
  letter-spacing: 0.015em;
}

nav.tabs {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  gap: 0.125rem;
  margin-left: auto;
  padding: 0.125rem;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  overscroll-behavior-inline: contain;
  scrollbar-color: var(--line-strong) transparent;
  scrollbar-width: thin;
}

nav.tabs::-webkit-scrollbar { height: 4px; }

nav.tabs button {
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  min-height: 1.75rem;
  padding: 0.3rem 0.62rem;
  font-size: 0.75rem;
  font-weight: 560;
  line-height: 1.25;
  cursor: pointer;
  transition: color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

nav.tabs button:hover { color: var(--fg); }

nav.tabs button.selected {
  background: var(--raised);
  color: var(--fg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}

.theme-toggle {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.0625rem;
  padding: 0.1rem;
  border: 1px solid var(--line);
  border-radius: 999px;
}

.theme-toggle button {
  display: grid;
  width: 1.65rem;
  height: 1.65rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--faint);
  font-size: 0.75rem;
  line-height: 1;
  cursor: pointer;
  transition: color 150ms ease, background 150ms ease;
}

.theme-toggle button:hover { color: var(--fg); }
.theme-toggle button[aria-checked="true"] {
  background: var(--surface-2);
  color: var(--fg);
}

.theme-icon {
  position: relative;
  display: block;
  width: 0.8rem;
  height: 0.8rem;
  color: currentColor;
}

.theme-icon--dark,
.theme-icon--light {
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.theme-icon--dark { box-shadow: inset -0.2rem 0 0 currentColor; }

.theme-icon--light::before,
.theme-icon--light::after {
  position: absolute;
  inset: -0.25rem 0.27rem;
  border-block: 1px solid currentColor;
  content: "";
}

.theme-icon--light::after { transform: rotate(90deg); }

.theme-icon--auto {
  border: 1.5px solid currentColor;
  border-radius: 0.15rem;
}

.theme-icon--auto::after {
  position: absolute;
  right: 0.18rem;
  bottom: -0.22rem;
  left: 0.18rem;
  height: 1px;
  background: currentColor;
  content: "";
}

.workspace-context {
  position: relative;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
}

.workspace-context-inner {
  display: flex;
  align-items: center;
  gap: 0.75rem 1rem;
  min-height: 2.75rem;
  padding-block: 0.4rem;
}

.workspace-title h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 0.95rem;
  line-height: 1.2;
  letter-spacing: -0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-title {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  gap: 0.65rem;
  min-width: 0;
}

.engine-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
  gap: 0.3rem;
  max-width: 48rem;
  margin-left: auto;
}

.meta-pill,
.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
  min-height: 1.5rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.75rem;
  letter-spacing: 0.025em;
  box-shadow: 0 1px 1px rgb(0 0 0 / 4%);
}

.principal-context {
  appearance: none;
  flex: 0 0 auto;
  max-width: 100%;
  cursor: pointer;
}

.principal-context > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.principal-context:hover {
  border-color: var(--accent-text);
  color: var(--fg);
}

.connection-status { color: var(--success); }
.connection-status.pending { color: var(--muted); }
.connection-status.unavailable { color: var(--danger); }

.connection-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  flex: 0 0 auto;
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
}

.workspace-main {
  position: relative;
  z-index: 1;
  padding-block: 0.5rem;
}

.workspace-main > h2:first-child { margin-bottom: 0.25rem; }

.capabilities-layout {
  display: grid;
  grid-template-columns: clamp(15rem, 21vw, 18rem) minmax(0, 1fr);
  gap: 0;
  align-items: start;
  height: calc(100vh - 6.5rem);
  height: calc(100dvh - 6.5rem);
  min-height: 30rem;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 0.65rem;
  background: var(--raised);
  box-shadow: var(--shadow-soft);
}

.capability-sidebar {
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 0.75rem 0.65rem;
  overflow: auto;
  overscroll-behavior: contain;
  border-right: 1px solid var(--line);
  background: var(--surface);
}

.capability-sidebar-heading {
  margin: 0 0 0.15rem;
  font-size: 0.875rem;
  letter-spacing: -0.01em;
}

.capability-count {
  margin: 0 0 0.55rem;
  color: var(--muted);
  font-size: 0.75rem;
}

.capability-filter-label {
  margin-top: 0;
  font-size: 0.75rem;
}

.capability-search {
  width: 100%;
  margin-bottom: 0.65rem;
}

.capability-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.capability-list button {
  position: relative;
  width: 100%;
  overflow: hidden;
  min-height: 2.75rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--control-line);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--body);
  font-size: 0.75rem;
  text-align: left;
  text-overflow: clip;
  white-space: normal;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
}

.capability-list button:hover {
  border-color: var(--line-strong);
  color: var(--fg);
}

.capability-choice-title {
  display: block;
  color: inherit;
  font-weight: 620;
  line-height: 1.25;
}

.capability-choice-id {
  display: block;
  margin-top: 0.15rem;
  color: var(--muted);
  font-size: 0.6875rem;
  line-height: 1.3;
  overflow-wrap: anywhere;
  white-space: normal;
}

.capability-choice.selected .capability-choice-id { color: inherit; }
.capability-filter-empty { margin-top: 0.5rem; padding: 0.6rem; }
.capability-detail-empty { margin: 0.85rem 1rem; }

.capability-list button.selected {
  border-color: var(--accent);
  background: var(--accent-low);
  color: var(--accent-text);
}

.capability-list button.selected::before {
  position: absolute;
  top: 50%;
  left: -1px;
  width: 2px;
  height: 55%;
  border-radius: 0 999px 999px 0;
  background: var(--accent);
  content: "";
  transform: translateY(-50%);
}

.capability-pane {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
}

.capability-detail {
  min-width: 0;
  padding: 0.85rem 1rem 1.25rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.capability-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
  margin-bottom: 0.5rem;
}

.capability-heading h2 {
  margin: 0;
  line-height: 1.15;
}

.capability-id {
  max-width: 100%;
  overflow: hidden;
  padding: 0.18rem 0.42rem;
  border: 1px solid var(--line);
  border-radius: 0.3rem;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capability-description {
  max-width: 46rem;
  margin-bottom: 0.75rem;
  color: var(--body);
}

.annotations { margin: 0.55rem 0; }

.invoke-panel {
  margin: 0.75rem 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--line);
}

.invoke-panel > h3 { margin-bottom: 0.15rem; font-size: 1rem; }

.invoke-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: 0.75rem;
}

.invoke-request,
.invoke-result { min-width: 0; }

.invoke-result .result-window { margin-top: 0; }
.invoke-workspace textarea.editor,
.invoke-workspace pre.result { min-height: 12.75rem; }

.field-label,
label {
  display: block;
  margin: 0.6rem 0 0.3rem;
  color: var(--body);
  font-size: 0.75rem;
  font-weight: 620;
}

.code-window {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--control-line);
  border-radius: 0.5rem;
  background: var(--surface);
  box-shadow: var(--shadow-soft);
}

.code-window-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 1.9rem;
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-family: "JetBrains Mono", monospace;
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

textarea.editor {
  display: block;
  width: 100%;
  min-height: 8rem;
  resize: vertical;
  padding: 0.75rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  font-size: 0.75rem;
  line-height: 1.55;
  tab-size: 2;
}

textarea.editor:focus-visible { outline-offset: -3px; }

input[type="text"],
input[type="search"],
.principal-create textarea {
  min-width: 0;
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--control-line);
  border-radius: 0.375rem;
  background: var(--surface);
  color: var(--fg);
}

input::placeholder,
textarea::placeholder { color: var(--faint); }

.invoke-actions,
.principal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.6rem 0;
}

.invoke-actions button,
.principal-actions button,
.principal-create button {
  min-height: 2rem;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--line-strong);
  border-radius: 0.375rem;
  background: var(--raised);
  color: var(--fg);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease;
}

.invoke-actions button:hover,
.principal-actions button:hover,
.principal-create button:hover {
  border-color: var(--accent);
}

.invoke-actions button.primary,
.principal-create button {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

.invoke-actions button.primary:hover,
.principal-create button:hover {
  background: var(--accent-hover);
  color: var(--accent-hover-fg);
}

.result-window { margin-top: 0.9rem; }

pre.raw,
pre.result,
pre.attributes {
  max-width: 100%;
  overflow-x: auto;
  margin: 0.5rem 0;
  padding: 0.65rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--body);
  font-size: 0.71875rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code-window pre.result {
  min-height: 4.5rem;
  margin: 0;
  padding: 0.75rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--fg);
}

pre.result:empty::before {
  color: var(--faint);
  content: "Invoke the capability to inspect its structured result.";
}

pre.error,
.code-window:has(pre.error) { border-color: var(--danger); }

.feedback {
  min-height: 1.25rem;
  margin: 0.5rem 0;
  color: var(--danger);
  font-size: 0.75rem;
}

.feedback:empty { min-height: 0; margin: 0; }

.hint {
  color: var(--muted);
  font-size: 0.8125rem;
}

.empty {
  padding: 1rem;
  border: 1px dashed var(--line-strong);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--muted);
}

.badge {
  display: inline-flex;
  align-items: center;
  margin-right: 0.3rem;
  padding: 0.14rem 0.4rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.35;
  letter-spacing: 0.035em;
}

.badge.ok { border-color: var(--success); background: var(--success-low); color: var(--success); }
.badge.error { border-color: var(--danger); background: var(--danger-low); color: var(--danger); }
.badge.warn { border-color: var(--warning); background: var(--warning-low); color: var(--warning); }

details { margin-top: 0.6rem; }

details > summary {
  display: flex;
  align-items: center;
  width: fit-content;
  min-height: 2rem;
  padding-block: 0.25rem;
  border-radius: 0.25rem;
  color: var(--body);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

details > summary:hover { color: var(--accent-text); }

.trace-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-top: 0.8rem;
}

.trace-row {
  min-width: 0;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--surface);
  color: var(--body);
  font-size: 0.75rem;
  box-shadow: 0 1px 1px rgb(0 0 0 / 3%);
}

.trace-row.invocation,
.trace-row.notice,
.trace-row.exchange > summary {
  display: grid;
  grid-template-columns: minmax(5.5rem, 0.65fr) max-content minmax(0, 2fr) max-content;
  align-items: center;
  gap: 0.4rem 0.55rem;
}

.trace-row.notice { grid-template-columns: minmax(5.5rem, 0.65fr) max-content minmax(0, 2fr); }

details.trace-row {
  margin: 0;
  padding: 0;
}

.trace-row.exchange > summary {
  width: auto;
  padding: 0.5rem 0.65rem;
}

.trace-row code {
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--fg);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-row .time,
.trace-row .duration {
  overflow: hidden;
  color: var(--faint);
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace-row .duration { color: var(--muted); text-align: right; }
.trace-row.exchange > .field-label { margin-inline: 0.65rem; }
.trace-row.exchange > pre.raw {
  width: calc(100% - 1.3rem);
  margin: 0.3rem 0.65rem 0.65rem;
}

.doctor-panel {
  min-width: 0;
  max-width: 64rem;
}

.doctor-heading,
.doctor-title-group,
.diagnostic-section-heading,
.diagnostic-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.doctor-heading {
  justify-content: space-between;
  gap: 0.5rem 1rem;
}

.doctor-title-group { gap: 0.4rem 0.65rem; min-width: 0; }
.doctor-title-group h2,
.doctor-engine,
.doctor-state,
.diagnostic-section-heading h3,
.diagnostic-message { margin: 0; }

.doctor-engine {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doctor-state { flex: 0 0 auto; }

.doctor-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem 1rem;
  margin-top: 0.65rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 0.5rem;
  background: var(--surface);
}

.doctor-summary--healthy {
  border-left-color: var(--success);
  background: color-mix(in srgb, var(--success-low) 45%, var(--surface));
}

.doctor-summary--issues {
  border-left-color: var(--danger);
  background: color-mix(in srgb, var(--danger-low) 45%, var(--surface));
}

.doctor-summary-copy { min-width: 0; margin: 0; color: var(--body); }

.doctor-stats {
  display: flex;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
  background: var(--raised);
}

.doctor-stat { min-width: 4.5rem; padding: 0.35rem 0.55rem; }
.doctor-stat + .doctor-stat { border-left: 1px solid var(--line); }
.doctor-stat dt {
  color: var(--muted);
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.doctor-stat dd { margin: 0.05rem 0 0; color: var(--fg); font-weight: 650; }

.diagnostic-section { margin-top: 0.8rem; }
.diagnostic-section-heading { gap: 0.4rem; margin-bottom: 0.35rem; }
.diagnostic-list { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }

.diagnostic-item {
  min-width: 0;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--line);
  border-left-width: 2px;
  border-radius: 0.375rem;
  background: var(--surface);
}

.diagnostic-item--finding { border-left-color: var(--danger); }
.diagnostic-item--note { border-left-color: var(--warning); }
.diagnostic-heading { gap: 0.35rem; min-width: 0; }
.diagnostic-code {
  min-width: 0;
  overflow: hidden;
  color: var(--fg);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diagnostic-message { margin-top: 0.3rem; color: var(--body); }
.diagnostic-details { margin-top: 0.3rem; }
.doctor-empty { margin: 0; padding: 0.6rem 0.7rem; }
.doctor-load-error { max-width: 48rem; }

.principal-row {
  min-width: 0;
  max-width: 50rem;
  margin-bottom: 0.45rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  box-shadow: 0 1px 1px rgb(0 0 0 / 3%);
}

.principal-row.active {
  border-color: var(--accent);
  box-shadow: inset 3px 0 var(--accent), var(--shadow-soft);
}

.principal-summary {
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4rem 0.65rem;
}

.principal-summary code { color: var(--muted); font-size: 0.75rem; }

.principal-status { min-height: 1rem; margin: 0.35rem 0 0; font-size: 0.75rem; }
.principal-status:empty { display: none; }
.principal-attributes { margin-top: 0.35rem; }

.principal-actions button.danger {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--line));
  color: var(--danger);
}

.principal-actions button.danger:hover {
  border-color: var(--danger);
  background: var(--danger-low);
}

.principal-actions button.credential-action {
  border-color: color-mix(in srgb, var(--warning) 55%, var(--line));
  color: var(--warning);
}

.principal-actions button.credential-action:hover {
  border-color: var(--warning);
  background: var(--warning-low);
}

[hidden] { display: none !important; }

.principal-create {
  display: block;
  min-width: 0;
  max-width: 50rem;
  margin-top: 1rem;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
}

.principal-create > summary {
  width: 100%;
  padding: 0.55rem 0.7rem;
  color: var(--fg);
}

.principal-create[open] > summary { border-bottom: 1px solid var(--line); }
.principal-create > :not(summary) {
  max-width: calc(100% - 1.4rem);
  margin-inline: 0.7rem;
}
.principal-create > .hint { margin-block: 0.6rem 0; }
.principal-create button { width: fit-content; margin-top: 0.45rem; }
.principal-create > .principal-status { margin-bottom: 0.65rem; }
#principal-token-guidance { max-width: 76ch; }

@media (max-width: 58rem) {
  .topbar-inner { flex-wrap: wrap; gap: 0.4rem 0.75rem; padding-block: 0.4rem; }
  nav.tabs { order: 3; flex: 1 1 100%; width: 100%; margin-left: 0; }
  nav.tabs button { flex: 1 0 auto; }
  .theme-toggle { margin-left: auto; }
  .workspace-context-inner { flex-wrap: wrap; gap: 0.5rem 1rem; }
  .engine-meta { justify-content: flex-start; width: 100%; max-width: none; margin-left: 0; }
  .capabilities-layout { height: auto; min-height: 0; }
  .capability-sidebar,
  .capability-pane { height: auto; }
  .invoke-workspace { grid-template-columns: minmax(0, 1fr); }
  .invoke-workspace textarea.editor,
  .invoke-workspace pre.result { min-height: 8rem; }
}

@media (max-width: 44rem) {
  .content-frame { width: min(calc(100% - 1rem), 90rem); }
  .product-name { display: none; }
  .workspace-title { width: 100%; }
  .engine-version,
  .engine-capability-count { display: none; }
  .workspace-main { padding-block: 0.5rem 1rem; }
  .capabilities-layout { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .capability-sidebar {
    min-height: 0;
    padding: 0.6rem;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .capability-list {
    display: flex;
    flex-direction: column;
    max-height: 14rem;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 0.2rem 0.2rem 0;
    overscroll-behavior-block: contain;
    scrollbar-color: var(--line-strong) transparent;
    scrollbar-width: thin;
  }
  .capability-list button { flex: 0 1 auto; }
  .capability-pane { overflow: visible; }
  .capability-detail { padding: 0.75rem; }

  .trace-row.invocation,
  .trace-row.notice,
  .trace-row.exchange > summary {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.3rem 0.5rem;
  }

  .trace-row .time { grid-column: 1; grid-row: 1; }
  .trace-row .duration { grid-column: 2; grid-row: 1; }
  .trace-row .badge { grid-column: 1; grid-row: 2; justify-self: start; }
  .trace-row code,
  .trace-row.notice > span:last-child {
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .doctor-heading { align-items: flex-start; }
  .doctor-summary { grid-template-columns: minmax(0, 1fr); }
  .doctor-stats { width: 100%; }
  .doctor-stat { flex: 1 1 0; min-width: 0; }
}

@media (max-width: 27rem) {
  .content-frame { width: min(calc(100% - 0.75rem), 90rem); }
  .theme-toggle button { width: 1.5rem; height: 1.5rem; }
  nav.tabs button { padding-inline: 0.5rem; }
  .workspace-title { gap: 0.45rem; }
  .blueprint-rails { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media (forced-colors: active) {
  nav.tabs button.selected,
  .theme-toggle button[aria-checked="true"],
  .capability-list button.selected,
  .principal-row.active {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
  }

  .status-dot { forced-color-adjust: none; }
}
`;
