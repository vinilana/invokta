export const attachedStyles = `
:root,
:root[data-theme="light"] {
  color-scheme: light;
  --att-bg: #ffffff;
  --att-surface: #fafafa;
  --att-surface-2: #f4f4f5;
  --att-raised: #ffffff;
  --att-fg: #18181b;
  --att-body: #52525b;
  --att-muted: #71717a;
  --att-faint: #a1a1aa;
  --att-line: #e4e4e7;
  --att-line-strong: #d4d4d8;
  --att-control: #85858e;
  --att-grid: #e6e6e9;
  --att-accent: #3d50f5;
  --att-accent-hover: #2a3ce0;
  --att-accent-text: #3d50f5;
  --att-accent-low: #eaecfe;
  --att-on-accent: #ffffff;
  --att-success: #0f6b49;
  --att-success-low: #e5f5ee;
  --att-warning: #7a4800;
  --att-warning-low: #fef3c7;
  --att-danger: #c9364b;
  --att-danger-low: #fff0f2;
  --att-header: rgb(255 255 255 / 90%);
  --att-rail: rgb(230 230 233 / 88%);
  --att-shadow: 0 1px 2px rgb(24 24 27 / 5%), 0 10px 30px rgb(24 24 27 / 5%);
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --att-bg: #09090b;
  --att-surface: #0e0e11;
  --att-surface-2: #18181b;
  --att-raised: #18181b;
  --att-fg: #fafafa;
  --att-body: #a1a1aa;
  --att-muted: #a1a1aa;
  --att-faint: #71717a;
  --att-line: #27272a;
  --att-line-strong: #3f3f46;
  --att-control: #696974;
  --att-grid: #1e1e20;
  --att-accent: #3369ff;
  --att-accent-hover: #5a85ff;
  --att-accent-text: #6f93ff;
  --att-accent-low: #16224a;
  --att-on-accent: #ffffff;
  --att-success: #4fd19b;
  --att-success-low: #102d22;
  --att-warning: #e7ad4b;
  --att-warning-low: #342511;
  --att-danger: #ff7789;
  --att-danger-low: #391820;
  --att-header: rgb(9 9 11 / 88%);
  --att-rail: rgb(30 30 32 / 90%);
  --att-shadow: 0 1px 2px rgb(0 0 0 / 28%), 0 16px 42px rgb(0 0 0 / 20%);
}

* { box-sizing: border-box; }

html {
  background: var(--att-bg);
  overflow-x: clip;
  -webkit-text-size-adjust: 100%;
}

body.attached-mode {
  min-width: 0;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  overflow-x: clip;
  background: var(--att-bg);
  color: var(--att-fg);
  font-family: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.875rem;
  line-height: 1.45;
  text-rendering: optimizeLegibility;
}

.att-shell button,
.att-shell input,
.att-shell textarea { font: inherit; }

.att-shell button { -webkit-tap-highlight-color: transparent; }

.att-mono,
.att-pill,
.att-tool-name,
.att-shell pre,
.att-shell textarea {
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}

.att-shell h1,
.att-shell h2,
.att-shell h3,
.att-shell p { margin-top: 0; }

.att-shell h1,
.att-shell h2,
.att-shell h3 {
  color: var(--att-fg);
  font-weight: 640;
  letter-spacing: -0.025em;
}

.att-shell h1 { font-size: 0.95rem; }
.att-shell h2 { font-size: 1rem; }
.att-shell h3 { font-size: 0.875rem; }

.att-shell ::selection {
  background: var(--att-accent-low);
  color: var(--att-fg);
}

.att-shell button:focus-visible,
.att-shell a:focus-visible,
.att-shell input:focus-visible,
.att-shell textarea:focus-visible,
.att-shell [role="tab"]:focus-visible,
.att-shell [role="tabpanel"]:focus-visible,
.att-shell [role="radio"]:focus-visible {
  outline: 2px solid var(--att-accent-text);
  outline-offset: 2px;
}

.att-shell button:disabled {
  cursor: wait;
  opacity: 0.58;
}

.att-shell {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  isolation: isolate;
}

.att-rails {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.att-rails span {
  position: absolute;
  inset-block: 0;
  width: 1px;
  background: var(--att-rail);
}

.att-rails span:nth-child(1) { left: 9.2%; }
.att-rails span:nth-child(2) { left: 20.5%; }
.att-rails span:nth-child(3) { left: 52.6%; }
.att-rails span:nth-child(4) { left: 84.5%; }
.att-rails span:nth-child(5) { left: 95.8%; }

.att-frame {
  width: min(calc(100% - 1.25rem), 90rem);
  margin-inline: auto;
}

.att-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  min-height: 2.75rem;
  border-bottom: 1px solid var(--att-line);
  background: var(--att-header);
  backdrop-filter: blur(18px) saturate(140%);
}

.att-topbar-inner {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 2.75rem;
}

.att-brand {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.42rem;
  min-width: max-content;
}

.att-brand-mark {
  display: block;
  width: 1.5rem;
  height: auto;
}

.att-brand-name {
  font-size: 0.95rem;
  font-weight: 690;
  letter-spacing: -0.035em;
}

.att-product-name {
  margin-left: 0.12rem;
  color: var(--att-muted);
  font-size: 0.75rem;
  letter-spacing: 0.015em;
}

.att-tabs,
.att-segmented {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  padding: 0.125rem;
  overflow-x: auto;
  border: 1px solid var(--att-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--att-surface) 84%, transparent);
  scrollbar-width: thin;
}

.att-tabs { margin-left: auto; }
.att-topbar-spacer { margin-left: auto; }

.att-tabs button,
.att-segmented button {
  flex: 0 0 auto;
  min-height: 1.75rem;
  padding: 0.28rem 0.65rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--att-muted);
  font-size: 0.75rem;
  font-weight: 590;
  cursor: pointer;
}

.att-tabs button:hover,
.att-segmented button:hover { color: var(--att-fg); }

.att-tabs button[aria-selected="true"],
.att-segmented button[aria-checked="true"] {
  background: var(--att-raised);
  color: var(--att-fg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}

.att-theme-slot {
  display: flex;
  flex: 0 0 auto;
}

.att-theme-slot-compact { display: none; }

.att-theme-slot .theme-toggle {
  display: flex;
  gap: 0.0625rem;
  padding: 0.1rem;
  border: 1px solid var(--att-line);
  border-radius: 999px;
}

.att-theme-slot .theme-toggle button {
  display: grid;
  width: 1.65rem;
  height: 1.65rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--att-faint);
  cursor: pointer;
}

.att-theme-slot .theme-compact {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  place-items: center;
  padding: 0;
  border: 1px solid var(--att-line);
  border-radius: 999px;
  background: var(--att-surface);
  color: var(--att-fg);
  cursor: pointer;
}

.att-theme-slot .theme-toggle button[aria-checked="true"] {
  background: var(--att-surface-2);
  color: var(--att-fg);
}

.att-theme-slot .theme-icon {
  position: relative;
  display: block;
  width: 0.8rem;
  height: 0.8rem;
  color: currentColor;
}

.att-theme-slot .theme-icon--dark,
.att-theme-slot .theme-icon--light {
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.att-theme-slot .theme-icon--dark { box-shadow: inset -0.2rem 0 0 currentColor; }

.att-theme-slot .theme-icon--light::before,
.att-theme-slot .theme-icon--light::after {
  position: absolute;
  inset: -0.25rem 0.27rem;
  border-block: 1px solid currentColor;
  content: "";
}

.att-theme-slot .theme-icon--light::after { transform: rotate(90deg); }

.att-theme-slot .theme-icon--auto {
  border: 1.5px solid currentColor;
  border-radius: 0.15rem;
}

.att-theme-slot .theme-icon--auto::after {
  position: absolute;
  right: 0.18rem;
  bottom: -0.22rem;
  left: 0.18rem;
  height: 1px;
  background: currentColor;
  content: "";
}

.att-context {
  border-bottom: 1px solid var(--att-line);
  background: color-mix(in srgb, var(--att-bg) 94%, transparent);
}

.att-context-inner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.65rem;
  padding-block: 0.38rem;
}

.att-context-title {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  min-width: 0;
  gap: 0.08rem;
}

.att-context-title .att-kicker { margin-bottom: 0; }

.att-context h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-context-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.3rem;
  margin-left: auto;
}

.att-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.34rem;
  min-height: 1.45rem;
  padding: 0.18rem 0.5rem;
  border: 1px solid var(--att-line);
  border-radius: 999px;
  background: var(--att-surface);
  color: var(--att-muted);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

.att-pill.success { color: var(--att-success); }
.att-pill.warning { color: var(--att-warning); }
.att-pill.danger { color: var(--att-danger); }

.att-dot {
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
}

.att-main { padding-block: 0.5rem; }

.att-card {
  border: 1px solid var(--att-line);
  border-radius: 0.625rem;
  background: var(--att-raised);
  box-shadow: var(--att-shadow);
}

.att-idle {
  display: grid;
  grid-template-columns: minmax(15rem, 22rem) minmax(0, 1fr);
  min-height: min(30rem, calc(100dvh - 7rem));
  overflow: hidden;
}

.att-idle-intro {
  padding: clamp(1.15rem, 3vw, 2rem);
  border-right: 1px solid var(--att-line);
  background: var(--att-surface);
}

.att-idle-intro h2 {
  margin-bottom: 0.45rem;
  font-size: clamp(1.25rem, 2vw, 1.6rem);
}

.att-idle-intro p {
  max-width: 30rem;
  color: var(--att-body);
}

.att-idle-form { padding: clamp(1rem, 2.4vw, 1.5rem); }
.att-idle-form > form { max-width: 48rem; }

.att-idle-orient {
  max-width: 48rem;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid var(--att-line);
}

.att-idle-orient h3 { margin-bottom: 0.35rem; }

.att-idle-orient p {
  margin-bottom: 0;
  color: var(--att-body);
}

.att-idle-orient-paths {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0.2rem 1rem;
  margin: 0.75rem 0 0;
}

.att-idle-orient-paths dt {
  color: var(--att-fg);
  font-weight: 620;
}

.att-idle-orient-paths dd { margin: 0; color: var(--att-body); }

.att-section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}

.att-section-heading h2,
.att-section-heading h3 { margin: 0; }

.att-kicker {
  margin-bottom: 0.35rem;
  color: var(--att-accent-text);
  font-size: 0.75rem;
  font-weight: 680;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.att-hint {
  color: var(--att-muted);
  font-size: 0.75rem;
}

.att-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.att-fieldset > legend,
.att-label {
  display: block;
  margin: 0.58rem 0 0.28rem;
  color: var(--att-body);
  font-size: 0.75rem;
  font-weight: 640;
}

.att-fieldset > legend { margin-bottom: 0.35rem; }

.att-input,
.att-textarea {
  width: 100%;
  min-width: 0;
  padding: 0.48rem 0.58rem;
  border: 1px solid var(--att-control);
  border-radius: 0.375rem;
  background: var(--att-surface);
  color: var(--att-fg);
}

.att-input { min-height: 2.15rem; }

.att-input::placeholder,
.att-textarea::placeholder { color: var(--att-faint); }

.att-input[aria-invalid="true"] {
  border-color: var(--att-danger);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--att-danger) 32%, transparent);
}

.att-textarea {
  min-height: 13rem;
  resize: vertical;
  line-height: 1.55;
  tab-size: 2;
}

.att-inline-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 0.45rem;
  margin-bottom: 0.45rem;
}

.att-inline-fields.single { grid-template-columns: minmax(0, 1fr) auto; }

.att-inline-fields .att-label { margin-top: 0; }

.att-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.7rem;
}

.att-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.1rem;
  padding: 0.36rem 0.72rem;
  border: 1px solid var(--att-line-strong);
  border-radius: 0.375rem;
  background: var(--att-raised);
  color: var(--att-fg);
  font-size: 0.75rem;
  font-weight: 620;
  text-decoration: none;
  cursor: pointer;
}

.att-button:hover { border-color: var(--att-accent); }

.att-button.primary {
  border-color: var(--att-accent);
  background: var(--att-accent);
  color: var(--att-on-accent);
}

.att-button.primary:hover { background: var(--att-accent-hover); }

.att-button.danger {
  border-color: var(--att-danger);
  color: var(--att-danger);
}

.att-icon-button {
  min-width: 2.1rem;
  min-height: 2.1rem;
  padding: 0.35rem;
}

.att-feedback {
  min-height: 1.1rem;
  margin: 0.55rem 0 0;
  color: var(--att-danger);
  font-size: 0.75rem;
}

.att-feedback:empty { min-height: 0; margin: 0; }

.att-workbench {
  min-height: 30rem;
  height: calc(100vh - 6.45rem);
  height: calc(100dvh - 6.45rem);
  overflow: hidden;
}

.att-tools-layout {
  display: grid;
  grid-template-columns: clamp(14rem, 20vw, 18rem) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.att-tool-sidebar {
  min-width: 0;
  min-height: 0;
  padding: 0.7rem 0.62rem;
  overflow: auto;
  border-right: 1px solid var(--att-line);
  background: var(--att-surface);
  overscroll-behavior: contain;
}

.att-tool-sidebar h2 { margin-bottom: 0.08rem; }
.att-tool-sidebar .att-input { margin-block: 0.55rem; }

.att-tool-list {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}

.att-tool-choice {
  width: 100%;
  min-height: 2.6rem;
  padding: 0.42rem 0.52rem;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--att-body);
  text-align: left;
  cursor: pointer;
}

.att-tool-choice:hover {
  border-color: var(--att-line-strong);
  color: var(--att-fg);
}

.att-tool-choice[aria-selected="true"] {
  border-color: var(--att-accent);
  background: var(--att-accent-low);
  color: var(--att-accent-text);
}

.att-tool-title {
  display: block;
  overflow: hidden;
  font-size: 0.75rem;
  font-weight: 640;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-tool-name {
  display: block;
  margin-top: 0.1rem;
  overflow: hidden;
  color: var(--att-muted);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.att-tool-detail {
  min-width: 0;
  min-height: 0;
  padding: 0.8rem;
  overflow: auto;
  overscroll-behavior: contain;
}

.att-tool-header {
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--att-line);
}

.att-tool-header h2 { margin-bottom: 0.2rem; }
.att-tool-header p { max-width: 58rem; margin-bottom: 0; color: var(--att-body); }

.att-tool-grid {
  display: grid;
  grid-template-columns: minmax(15rem, 0.78fr) minmax(20rem, 1.22fr);
  gap: 0.7rem;
  margin-top: 0.7rem;
}

.att-pane {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--att-line);
  border-radius: 0.5rem;
  background: var(--att-surface);
}

.att-pane-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  min-height: 2rem;
  padding: 0.36rem 0.58rem;
  border-bottom: 1px solid var(--att-line);
  color: var(--att-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.075em;
  text-transform: uppercase;
}

.att-pane-bar > span:last-child { color: var(--att-faint); }

.att-pane-tools {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 0.4rem;
}

.att-pane-tools > span {
  color: var(--att-faint);
  white-space: nowrap;
}

.att-copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-width: 4.5rem;
  min-height: 1.5rem;
  padding: 0.14rem 0.5rem;
  border: 1px solid var(--att-line-strong);
  border-radius: 999px;
  background: var(--att-raised);
  color: var(--att-muted);
  font-family: "Inter Tight", Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 0.75rem;
  font-weight: 620;
  letter-spacing: 0;
  text-transform: none;
  cursor: pointer;
}

.att-copy-button:hover {
  border-color: var(--att-accent);
  color: var(--att-fg);
}

.att-copy-button[data-state="copied"] {
  border-color: var(--att-success);
  background: var(--att-success-low);
  color: var(--att-success);
}

.att-copy-button[data-state="failed"] {
  border-color: var(--att-danger);
  background: var(--att-danger-low);
  color: var(--att-danger);
}

.att-tool-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin: 0.35rem 0 0.15rem;
}

.att-tag {
  display: inline-flex;
  align-items: center;
  min-height: 1.35rem;
  padding: 0.12rem 0.45rem;
  border: 1px solid var(--att-line-strong);
  border-radius: 999px;
  color: var(--att-muted);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

.att-tag.danger {
  border-color: var(--att-danger);
  background: var(--att-danger-low);
  color: var(--att-danger);
}

.att-shortcut {
  margin-left: auto;
  color: var(--att-faint);
  font-size: 0.75rem;
  white-space: nowrap;
}

.att-heading-actions { margin-top: 0; }
.att-numeric { text-align: right; }

.att-pane-body { padding: 0.62rem; }
.att-pane-body > .att-label:first-child { margin-top: 0; }

.att-pre {
  max-width: 100%;
  min-height: 13rem;
  margin: 0;
  padding: 0.68rem;
  overflow: auto;
  background: transparent;
  color: var(--att-body);
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.att-result {
  min-height: 9rem;
  border-top: 1px solid var(--att-line);
}

.att-empty {
  padding: 0.85rem;
  border: 1px dashed var(--att-line-strong);
  border-radius: 0.45rem;
  color: var(--att-muted);
}

.att-view {
  height: 100%;
  min-height: 0;
  padding: 0.8rem;
  overflow: auto;
}

.att-oauth {
  width: min(100%, 34rem);
  height: auto;
  margin-inline: auto;
  padding: 1rem;
}

.att-oauth h2 { margin-bottom: 0.4rem; }

.att-oauth-status {
  margin: 0.8rem 0 0;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--att-line);
  border-radius: 0.375rem;
  background: var(--att-surface);
  color: var(--att-body);
}

.att-activity-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--att-line);
  background: var(--att-surface);
  font-size: 0.75rem;
}

.att-activity-table th,
.att-activity-table td {
  padding: 0.48rem 0.55rem;
  border-bottom: 1px solid var(--att-line);
  color: var(--att-body);
  text-align: left;
  vertical-align: top;
}

.att-activity-table th {
  color: var(--att-muted);
  font-size: 0.75rem;
  letter-spacing: 0.065em;
  text-transform: uppercase;
}

.att-status-text.success { color: var(--att-success); }
.att-status-text.error { color: var(--att-danger); }

.att-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(10rem, 1fr));
  gap: 0.55rem;
  margin-top: 0.7rem;
}

.att-summary-item {
  min-width: 0;
  padding: 0.65rem;
  border: 1px solid var(--att-line);
  border-radius: 0.45rem;
  background: var(--att-surface);
}

.att-summary-label {
  display: block;
  margin-bottom: 0.2rem;
  color: var(--att-muted);
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0.065em;
  text-transform: uppercase;
}

.att-summary-value {
  display: block;
  overflow-wrap: anywhere;
  color: var(--att-fg);
}

.att-callout {
  margin-top: 0.7rem;
  padding: 0.65rem;
  border: 1px solid var(--att-line);
  border-left: 2px solid var(--att-accent);
  border-radius: 0.375rem;
  background: var(--att-surface);
  color: var(--att-body);
}

.att-loading {
  display: grid;
  min-height: 16rem;
  place-items: center;
  color: var(--att-muted);
}

.att-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 62rem) {
  .att-idle { grid-template-columns: minmax(11rem, 0.55fr) minmax(0, 1.45fr); }
  .att-tool-grid { grid-template-columns: 1fr; }
  .att-summary-grid { grid-template-columns: repeat(2, minmax(10rem, 1fr)); }
}

@media (max-width: 46rem) {
  .att-frame { width: min(calc(100% - 0.75rem), 90rem); }
  .att-product-name { display: none; }
  .att-theme-slot-full { display: none; }
  .att-theme-slot-compact { display: flex; }
  .att-context-inner { align-items: flex-start; flex-direction: column; gap: 0.35rem; }
  .att-context-meta { justify-content: flex-start; margin-left: 0; }
  .att-idle { display: block; min-height: 0; }
  .att-idle-intro { padding: 1rem; border-right: 0; border-bottom: 1px solid var(--att-line); }
  .att-idle-form { padding: 0.85rem; }
  .att-idle-orient-paths { grid-template-columns: minmax(0, 1fr); }
  .att-inline-fields,
  .att-inline-fields.single { grid-template-columns: minmax(0, 1fr); }
  .att-workbench { height: auto; min-height: calc(100dvh - 8rem); overflow: visible; }
  .att-tools-layout { display: block; height: auto; }
  .att-tool-sidebar { max-height: 15rem; border-right: 0; border-bottom: 1px solid var(--att-line); }
  .att-tool-detail { overflow: visible; }
  .att-tool-grid { grid-template-columns: minmax(0, 1fr); }
  .att-summary-grid { grid-template-columns: minmax(0, 1fr); }
  .att-activity-table { display: block; overflow-x: auto; white-space: nowrap; }
}

@media (max-width: 22rem) {
  .att-topbar-inner {
    flex-wrap: wrap;
    gap: 0.3rem;
    padding-block: 0.3rem;
  }

  .att-tabs {
    order: 3;
    width: 100%;
    margin-left: 0;
    overflow-x: visible;
    justify-content: center;
  }

  .att-tabs button { padding-inline: 0.5rem; }
  .att-theme-slot-compact { margin-left: auto; }

  .att-auth-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
    overflow: visible;
    border-radius: 0.5rem;
  }

  .att-auth-options button {
    width: 100%;
    min-width: 0;
    white-space: normal;
  }
}

.att-shortcuts-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  background: rgb(0 0 0 / 35%);
}

.att-shortcuts-card {
  min-width: 17rem;
  max-width: min(24rem, calc(100vw - 2rem));
  padding: 1rem 1.25rem;
  border: 1px solid var(--att-line);
  border-radius: 0.5rem;
  background: var(--att-raised);
  color: var(--att-body);
  box-shadow: var(--att-shadow);
}

.att-shortcuts-card h2 {
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
}

.att-shortcuts-list { margin: 0; }

.att-shortcuts-entry {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.2rem 0;
  font-size: 0.75rem;
}

.att-shortcuts-entry dt { margin: 0; }
.att-shortcuts-entry dd { margin: 0; }

.att-shortcuts-card kbd {
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--att-line-strong);
  border-radius: 0.25rem;
  background: var(--att-surface-2);
  font-family: inherit;
  font-size: 0.75rem;
  white-space: nowrap;
}

.att-shortcuts-card .att-hint { margin: 0.6rem 0 0; }

@media (prefers-reduced-motion: reduce) {
  .att-shell * { scroll-behavior: auto !important; transition-duration: 1ms !important; }
}
`;
