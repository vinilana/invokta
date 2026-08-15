import {
  cliAnnotationTags,
  cliControlId,
  cliErrorMessage,
  cliLabelFor,
  cliTextInput,
} from "./cli-components.js";
import {
  type CliApi,
  type CliCapabilityDescription,
  type CliCapabilitySummary,
  type CliJsonValue,
  nextRovingIndex,
  parseRunInput,
  seedCliInput,
} from "./cli-contract.js";
import { createCopyButton, formatDuration } from "./clipboard.js";
import { clear, el, pretty } from "./dom.js";

export interface CliCurrentResult {
  readonly id: string;
  readonly value: CliJsonValue;
}

export interface CliCommandsPanelOptions {
  readonly root: HTMLElement;
  readonly api: CliApi;
  readonly commands: readonly CliCapabilitySummary[];
  readonly commandsLoaded: boolean;
  readonly commandsLoading: boolean;
  readonly commandsError: string;
  readonly selectedId: string | undefined;
  readonly described: CliCapabilityDescription | undefined;
  readonly describeError: string;
  readonly commandQuery: string;
  readonly argumentDrafts: Map<string, string>;
  readonly currentResult: CliCurrentResult | undefined;
  retryCatalog(): void;
  setSelectedId(id: string | undefined): void;
  selectCommand(id: string, focus: boolean): void;
  setCommandQuery(query: string): void;
  setCurrentResult(result: CliCurrentResult): void;
  markActivityStale(): void;
}

function filterCommands(
  items: readonly CliCapabilitySummary[],
  query: string,
): readonly CliCapabilitySummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) =>
    [item.id, item.title ?? "", item.description].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function createCliCommandsPanel(
  options: CliCommandsPanelOptions,
): HTMLElement {
  if (options.commandsLoading && !options.commandsLoaded) {
    return el("section", { class: "att-loading" }, ["Loading commands…"]);
  }
  if (options.commandsError !== "" && !options.commandsLoaded) {
    const retry = el("button", { type: "button", class: "att-button" }, [
      "Refresh catalog",
    ]);
    retry.addEventListener("click", options.retryCatalog);
    return el("section", { class: "att-view" }, [
      el("h2", {}, ["Commands unavailable"]),
      el("p", { class: "att-feedback", role: "alert" }, [
        options.commandsError,
      ]),
      retry,
    ]);
  }

  let selectedId = options.selectedId;
  if (
    selectedId === undefined ||
    !options.commands.some(({ id }) => id === selectedId)
  ) {
    selectedId = options.commands[0]?.id;
    options.setSelectedId(selectedId);
  }
  const sidebar = el("aside", { class: "att-tool-sidebar" }, [
    el("h2", {}, ["Commands"]),
    el("p", { class: "att-hint" }, [
      `${String(options.commands.length)} advertised commands`,
    ]),
  ]);
  const search = cliTextInput({
    label: "Search commands",
    name: "command-search",
    value: options.commandQuery,
    placeholder: "Id, title, or description",
    type: "search",
    autocomplete: "off",
  });
  const list = el(
    "div",
    {
      class: "att-tool-list",
      role: "listbox",
      "aria-label": "Connected CLI commands",
    },
    [],
  );
  let visible: readonly CliCapabilitySummary[] = [];
  let choiceButtons: HTMLButtonElement[] = [];
  const focusChoice = (id: string): void => {
    Array.from(
      options.root.querySelectorAll<HTMLButtonElement>(".att-tool-choice"),
    )
      .find((candidate) => candidate.dataset.commandId === id)
      ?.focus();
  };
  const selectCommand = (id: string, focus: boolean): void => {
    options.selectCommand(id, focus);
    if (focus) focusChoice(id);
  };
  const paintCommands = (): void => {
    clear(list);
    const matches = filterCommands(options.commands, search.input.value);
    visible = matches;
    choiceButtons = [];
    if (matches.length === 0) {
      list.append(el("p", { class: "att-empty" }, ["No matching commands."]));
      return;
    }
    const rovingId = matches.some(({ id }) => id === selectedId)
      ? selectedId
      : matches[0]?.id;
    for (const item of matches) {
      const choice = el(
        "button",
        {
          type: "button",
          class: "att-tool-choice",
          role: "option",
          "aria-selected": String(item.id === selectedId),
          tabindex: item.id === rovingId ? "0" : "-1",
          "data-command-id": item.id,
        },
        [
          el("span", { class: "att-tool-title" }, [item.title ?? item.id]),
          el("span", { class: "att-tool-name" }, [item.id]),
        ],
      );
      choice.addEventListener("click", () => {
        selectCommand(item.id, true);
      });
      choiceButtons.push(choice);
      list.append(choice);
    }
  };
  search.input.addEventListener("input", () => {
    options.setCommandQuery(search.input.value);
    paintCommands();
  });
  list.addEventListener("keydown", (event) => {
    const current = choiceButtons.indexOf(event.target as HTMLButtonElement);
    const next = nextRovingIndex(
      current,
      choiceButtons.length,
      event.key,
      "vertical",
    );
    if (next === undefined) return;
    event.preventDefault();
    const item = visible[next];
    if (item !== undefined) selectCommand(item.id, true);
  });
  sidebar.append(search.field, list);
  paintCommands();

  const selected = options.commands.find(({ id }) => id === selectedId);
  if (selected === undefined) {
    return el("div", { class: "att-tools-layout" }, [
      sidebar,
      el("section", { class: "att-tool-detail" }, [
        el("div", { class: "att-empty" }, [
          "The connected CLI did not advertise any commands.",
        ]),
      ]),
    ]);
  }

  const contractCopy = el("p", { class: "att-hint" }, [
    "This CLI uses its own composition root. DevTools does not supply a principal. Each verb starts a new process and the process exits.",
  ]);

  if (options.described === undefined || options.described.id !== selected.id) {
    return el("div", { class: "att-tools-layout" }, [
      sidebar,
      el("section", { class: "att-tool-detail" }, [
        el("header", { class: "att-tool-header" }, [
          el("h2", {}, [selected.title ?? selected.id]),
          el("span", { class: "att-tool-name" }, [selected.id]),
        ]),
        contractCopy,
        options.describeError === ""
          ? el("p", { class: "att-hint" }, ["Reading the describe contract…"])
          : el("p", { class: "att-feedback", role: "alert" }, [
              options.describeError,
            ]),
      ]),
    ]);
  }

  const selectedDescription = options.described;
  const schemaText = pretty(selectedDescription.inputSchema);
  const schema = el("pre", { class: "att-pre" }, [schemaText]);
  const seed = seedCliInput(selectedDescription.inputSchema);
  const source = options.argumentDrafts.get(selectedDescription.id) ?? seed;
  const argumentsId = cliControlId("arguments");
  const argumentsEditor = el("textarea", {
    id: argumentsId,
    class: "att-textarea",
    spellcheck: "false",
    "aria-label": `JSON input for ${selectedDescription.id}`,
  });
  argumentsEditor.value = source;
  argumentsEditor.addEventListener("input", () => {
    options.argumentDrafts.set(selectedDescription.id, argumentsEditor.value);
  });
  const feedback = el("p", {
    class: "att-feedback",
    role: "alert",
    "aria-live": "assertive",
  });
  const emptyResult = "Run this command to inspect its current result.";
  const hasResult = options.currentResult?.id === selectedDescription.id;
  const result = el(
    "pre",
    {
      class: "att-pre att-result",
      role: "status",
      "aria-live": "polite",
      "aria-label": "Current result",
    },
    [hasResult ? pretty(options.currentResult?.value) : emptyResult],
  );
  const resultState = el("span", {}, [hasResult ? "Returned" : "Not run"]);
  const run = el("button", { type: "button", class: "att-button primary" }, [
    "Run",
  ]);
  const format = el("button", { type: "button", class: "att-button" }, [
    "Format JSON",
  ]);
  const reset = el("button", { type: "button", class: "att-button" }, [
    "Reset to schema",
  ]);
  const writeDraft = (value: string): void => {
    argumentsEditor.value = value;
    options.argumentDrafts.set(selectedDescription.id, value);
  };
  format.addEventListener("click", () => {
    feedback.textContent = "";
    try {
      writeDraft(pretty(parseRunInput(argumentsEditor.value)));
    } catch (error) {
      feedback.textContent = cliErrorMessage(error);
      argumentsEditor.focus();
    }
  });
  reset.addEventListener("click", () => {
    feedback.textContent = "";
    writeDraft(seed);
    argumentsEditor.focus();
  });
  const runCall = (): void => {
    if (run.disabled) return;
    feedback.textContent = "";
    let input: Readonly<Record<string, CliJsonValue>>;
    try {
      input = parseRunInput(argumentsEditor.value);
    } catch (error) {
      feedback.textContent = cliErrorMessage(error);
      return;
    }
    run.disabled = true;
    run.textContent = "Running…";
    resultState.textContent = "Waiting";
    result.textContent = "Waiting for the CLI…";
    const startedAt = performance.now();
    void options.api
      .run(selectedDescription.id, input)
      .then((value) => {
        options.setCurrentResult({ id: selectedDescription.id, value });
        result.textContent = pretty(value);
        resultState.textContent = `Returned · ${formatDuration(performance.now() - startedAt)}`;
      })
      .catch((error: unknown) => {
        feedback.textContent = cliErrorMessage(error);
        result.textContent = "No result was returned.";
        resultState.textContent = `Failed · ${formatDuration(performance.now() - startedAt)}`;
      })
      .finally(() => {
        run.disabled = false;
        run.textContent = "Run";
        options.markActivityStale();
      });
  };
  run.addEventListener("click", runCall);
  argumentsEditor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    runCall();
  });

  const tags = cliAnnotationTags(selectedDescription.annotations);
  const detail = el(
    "section",
    { id: "cli-command-detail", class: "att-tool-detail" },
    [
      el("header", { class: "att-tool-header" }, [
        el("h2", {}, [selectedDescription.title ?? selectedDescription.id]),
        el("span", { class: "att-tool-name" }, [selectedDescription.id]),
        ...(tags.length === 0
          ? []
          : [el("div", { class: "att-tool-tags" }, tags)]),
        el("p", {}, [selectedDescription.description]),
      ]),
      contractCopy,
      el("div", { class: "att-tool-grid" }, [
        el("section", { class: "att-pane", "aria-label": "Input schema" }, [
          el("div", { class: "att-pane-bar" }, [
            el("span", {}, ["Input schema"]),
            el("div", { class: "att-pane-tools" }, [
              el("span", {}, ["JSON Schema"]),
              createCopyButton(
                "input schema",
                () => schemaText,
                "att-copy-button",
              ),
            ]),
          ]),
          schema,
        ]),
        el("section", { class: "att-pane", "aria-label": "Manual run" }, [
          el("div", { class: "att-pane-bar" }, [
            el("span", {}, ["Run"]),
            el("span", {}, ["JSON"]),
          ]),
          el("div", { class: "att-pane-body" }, [
            cliLabelFor("Input", argumentsId, "att-label"),
            argumentsEditor,
            el("div", { class: "att-actions" }, [
              run,
              format,
              reset,
              el("span", { class: "att-shortcut" }, ["Ctrl/⌘ + Enter"]),
            ]),
            feedback,
          ]),
          el("div", { class: "att-pane-bar" }, [
            el("span", {}, ["Current result"]),
            el("div", { class: "att-pane-tools" }, [
              resultState,
              createCopyButton(
                "current result",
                () => {
                  const text = result.textContent ?? "";
                  return text === emptyResult ? "" : text;
                },
                "att-copy-button",
              ),
            ]),
          ]),
          result,
        ]),
      ]),
    ],
  );
  return el("div", { class: "att-tools-layout" }, [sidebar, detail]);
}
