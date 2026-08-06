export const styles = `
:root {
  color-scheme: light dark;
  --border: color-mix(in srgb, currentColor 18%, transparent);
  --muted: color-mix(in srgb, currentColor 55%, transparent);
  --accent: #4a63ff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  line-height: 1.5;
}
code, pre, textarea.editor { font-family: ui-monospace, monospace; }
header.app {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
header.app h1 { font-size: 1.05rem; margin: 0; }
header.app .version { color: var(--muted); }
nav.tabs { display: flex; gap: 0.25rem; margin-left: auto; }
nav.tabs button {
  border: 1px solid transparent;
  background: none;
  color: inherit;
  padding: 0.35rem 0.8rem;
  border-radius: 0.5rem;
  cursor: pointer;
}
nav.tabs button.selected {
  border-color: var(--border);
  background: color-mix(in srgb, currentColor 7%, transparent);
}
main { padding: 1.25rem; }
.capability-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  float: left;
  width: 16rem;
  margin-right: 1.5rem;
}
.capability-list button {
  text-align: left;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: none;
  color: inherit;
  cursor: pointer;
}
.capability-list button.selected { border-color: var(--accent); }
.capability-pane { overflow: hidden; }
.capability-id { color: var(--muted); }
textarea, input[type="text"] {
  width: 100%;
  max-width: 44rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: none;
  color: inherit;
}
button.primary { border-color: var(--accent); }
.invoke-actions { display: flex; gap: 0.5rem; margin: 0.5rem 0; }
.invoke-actions button, .principal-actions button, .principal-create button {
  padding: 0.35rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: none;
  color: inherit;
  cursor: pointer;
}
pre.raw, pre.result, pre.attributes {
  max-width: 60rem;
  overflow-x: auto;
  padding: 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 0.8rem;
}
pre.error { border-color: #d64550; }
.feedback { color: #d64550; min-height: 1.2rem; }
.hint { color: var(--muted); font-size: 0.85rem; }
.badge {
  display: inline-block;
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  padding: 0 0.4rem;
  font-size: 0.75rem;
  margin-right: 0.3rem;
}
.badge.ok { border-color: #3e9c5c; color: #3e9c5c; }
.badge.error { border-color: #d64550; color: #d64550; }
.badge.warn { border-color: #c9963c; color: #c9963c; }
.trace-list { display: flex; flex-direction: column; gap: 0.3rem; }
.trace-row {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
}
.trace-row .time { color: var(--muted); margin-right: 0.6rem; }
.trace-row .duration { color: var(--muted); margin-left: 0.6rem; }
.trace-row summary { cursor: pointer; }
.principal-row {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.6rem;
  margin-bottom: 0.5rem;
  max-width: 44rem;
}
.principal-row.active { border-color: var(--accent); }
.principal-summary { display: flex; gap: 0.6rem; align-items: baseline; }
.principal-actions { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
.principal-create { margin-top: 1.25rem; display: grid; gap: 0.5rem; max-width: 44rem; }
`;
