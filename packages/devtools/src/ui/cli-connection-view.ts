import {
  buildCliTarget,
  clearCliSecrets,
  completeConnectionAttempt,
  type CliConnectionState,
  type CliTarget,
  retainedActivityOf,
  type SecretControl,
  type TargetDraftField,
  TargetDraftValidationError,
} from "./cli-contract.js";
import {
  cliActivityTable,
  cliControlId,
  cliErrorMessage,
  cliLabelFor,
  cliTextInput,
} from "./cli-components.js";
import { clear, el } from "./dom.js";
import {
  createWorkbenchOrientation,
  mountedWorkbench,
} from "./workbench-chrome.js";

export type EditableCliEnvironmentPair = SecretControl & { name: string };

export interface EditableCliTargetDraft {
  command: string;
  args: string[];
  cwd: string;
  environment: EditableCliEnvironmentPair[];
}

export interface CliIdleViewOptions {
  readonly state: CliConnectionState;
  readonly draft: EditableCliTargetDraft;
  readonly connectionError: string;
  connect(target: CliTarget): Promise<CliConnectionState>;
  connected(state: CliConnectionState, carriesSecrets: boolean): void;
}

export function createCliIdleView(options: CliIdleViewOptions): HTMLElement {
  const { draft } = options;
  const intro = el("section", { class: "att-idle-intro" }, [
    el("p", { class: "att-kicker" }, ["Connection"]),
    el("h2", {}, ["Attach one Invokta CLI"]),
    el("p", {}, [
      "Name the executable, arguments, working directory, and environment the operator will type.",
    ]),
    el("p", { class: "att-hint" }, [
      "Nothing is discovered, imported, invoked, or saved automatically.",
    ]),
  ]);
  const formHost = el("section", {
    class: "att-idle-form",
    "aria-label": "Connection details",
  });

  const paintForm = (): void => {
    clear(formHost);
    const validationFields = new Map<string, HTMLInputElement>();
    const validationKey = (field: TargetDraftField, index?: number): string =>
      `${field}:${index === undefined ? "single" : String(index)}`;
    const feedback = el("p", {
      id: cliControlId("connection-feedback"),
      class: "att-feedback",
      role: "alert",
      "aria-live": "assertive",
    });
    feedback.textContent = options.connectionError;
    const registerValidationField = (
      field: TargetDraftField,
      input: HTMLInputElement,
      index?: number,
    ): void => {
      validationFields.set(validationKey(field, index), input);
      input.addEventListener("input", () => {
        if (input.getAttribute("aria-invalid") !== "true") return;
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-errormessage");
        feedback.textContent = "";
      });
    };

    const form = el("form", {}, []);
    const command = cliTextInput({
      label: "Command",
      name: "command",
      value: draft.command,
      placeholder: "node",
      autocomplete: "off",
    });
    command.input.required = true;
    command.input.addEventListener("input", () => {
      draft.command = command.input.value;
    });
    registerValidationField("command", command.input);
    const cwd = cliTextInput({
      label: "Working directory",
      name: "cwd",
      value: draft.cwd,
      placeholder: "Optional directory",
      autocomplete: "off",
    });
    cwd.input.addEventListener("input", () => {
      draft.cwd = cwd.input.value;
    });
    const argumentsHost = el("div", {}, []);
    const addArgumentRows = (
      host: HTMLElement,
      fallbackFocus?: HTMLElement,
      focusIndex?: number,
    ): void => {
      clear(host);
      for (const [index, argument] of draft.args.entries()) {
        const id = cliControlId("argument");
        const input = el("input", {
          id,
          class: "att-input",
          type: "text",
          "aria-label": `Argument ${String(index + 1)}`,
        });
        input.value = argument;
        input.addEventListener("input", () => {
          draft.args[index] = input.value;
        });
        const remove = el(
          "button",
          {
            type: "button",
            class: "att-button att-icon-button",
            "aria-label": `Remove argument ${String(index + 1)}`,
          },
          ["Remove"],
        );
        remove.addEventListener("click", () => {
          draft.args.splice(index, 1);
          const nextIndex = Math.min(index, draft.args.length - 1);
          addArgumentRows(
            host,
            fallbackFocus,
            nextIndex >= 0 ? nextIndex : undefined,
          );
          if (nextIndex < 0) fallbackFocus?.focus();
        });
        host.append(
          el("div", { class: "att-inline-fields single" }, [
            el("div", {}, [
              cliLabelFor(`Argument ${String(index + 1)}`, id),
              input,
            ]),
            remove,
          ]),
        );
      }
      if (focusIndex !== undefined) {
        host
          .querySelector<HTMLInputElement>(
            `[aria-label="Argument ${String(focusIndex + 1)}"]`,
          )
          ?.focus();
      }
    };
    const addArgument = el("button", { type: "button", class: "att-button" }, [
      "Add argument",
    ]);
    addArgument.addEventListener("click", () => {
      draft.args.push("");
      addArgumentRows(argumentsHost, addArgument, draft.args.length - 1);
    });
    addArgumentRows(argumentsHost, addArgument);

    const environmentHost = el("div", {}, []);
    const addPairRows = (
      host: HTMLElement,
      pairs: EditableCliEnvironmentPair[],
      fallbackFocus?: HTMLElement,
      focusIndex?: number,
    ): void => {
      clear(host);
      for (const [index, pair] of pairs.entries()) {
        const nameField = cliTextInput({
          label: "Variable name",
          name: "environment-name",
          value: pair.name,
          placeholder: "API_TOKEN",
        });
        const valueField = cliTextInput({
          label: "Variable value",
          name: "environment-value",
          value: pair.value,
          ...(pair.placeholder === undefined
            ? {}
            : { placeholder: pair.placeholder }),
          type: "password",
          autocomplete: "off",
        });
        nameField.input.addEventListener("input", () => {
          pair.name = nameField.input.value;
        });
        valueField.input.addEventListener("input", () => {
          pair.value = valueField.input.value;
        });
        registerValidationField("environment-name", nameField.input, index);
        registerValidationField("environment-value", valueField.input, index);
        const remove = el(
          "button",
          {
            type: "button",
            class: "att-button att-icon-button",
            "aria-label": `Remove environment row ${String(index + 1)}`,
          },
          ["Remove"],
        );
        remove.addEventListener("click", () => {
          clearCliSecrets([pair, valueField.input]);
          pairs.splice(index, 1);
          const nextIndex = Math.min(index, pairs.length - 1);
          addPairRows(
            host,
            pairs,
            fallbackFocus,
            nextIndex >= 0 ? nextIndex : undefined,
          );
          if (nextIndex < 0) fallbackFocus?.focus();
        });
        host.append(
          el("div", { class: "att-inline-fields" }, [
            nameField.field,
            valueField.field,
            remove,
          ]),
        );
      }
      if (focusIndex !== undefined) {
        validationFields
          .get(validationKey("environment-name", focusIndex))
          ?.focus();
      }
    };
    const addEnvironment = el(
      "button",
      { type: "button", class: "att-button" },
      ["Add environment variable"],
    );
    addEnvironment.addEventListener("click", () => {
      draft.environment.push({ name: "", value: "", placeholder: "" });
      addPairRows(
        environmentHost,
        draft.environment,
        addEnvironment,
        draft.environment.length - 1,
      );
    });
    addPairRows(environmentHost, draft.environment, addEnvironment);

    const connect = el(
      "button",
      { type: "submit", class: "att-button primary" },
      ["Connect"],
    );
    form.append(
      command.field,
      cwd.field,
      el("div", { class: "att-section-heading" }, [
        el("h3", {}, ["Arguments"]),
        el("span", { class: "att-hint" }, ["One exact value per row"]),
      ]),
      argumentsHost,
      addArgument,
      el("div", { class: "att-section-heading" }, [
        el("h3", {}, ["Environment"]),
        el("span", { class: "att-hint" }, ["Values stay in memory"]),
      ]),
      environmentHost,
      addEnvironment,
      el("div", { class: "att-actions" }, [connect]),
      feedback,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      feedback.textContent = "";
      let target: CliTarget;
      try {
        target = buildCliTarget({
          command: draft.command,
          args: draft.args,
          cwd: draft.cwd,
          environment: draft.environment,
        });
      } catch (error) {
        feedback.textContent = cliErrorMessage(error);
        if (error instanceof TargetDraftValidationError) {
          validationFields
            .get(validationKey(error.field, error.index))
            ?.setAttribute("aria-invalid", "true");
        }
        return;
      }
      const secretControls = [...draft.environment];
      const passwordInputs = Array.from(
        form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
      );
      const carriesSecrets = secretControls.length > 0;
      connect.disabled = true;
      connect.textContent = "Connecting…";
      void completeConnectionAttempt(options.connect(target), [
        ...secretControls,
        ...passwordInputs,
      ])
        .then((state) => {
          options.connected(state, carriesSecrets);
        })
        .catch((error: unknown) => {
          connect.disabled = false;
          connect.textContent = "Connect";
          feedback.textContent = cliErrorMessage(error);
        });
    });

    const launched = mountedWorkbench();
    const orientation = el("aside", { class: "att-idle-orient" }, [
      el("h3", {}, ["This is the CLI workbench."]),
      el("p", {}, [
        "It inspects an installed Invokta CLI without loading an engine.",
      ]),
      createWorkbenchOrientation(launched),
      el("dl", { class: "att-idle-orient-paths" }, [
        ...(launched === undefined
          ? [
              el("dt", {}, ["MCP workbench"]),
              el("dd", {}, [
                el("div", { class: "att-mono" }, [
                  "invokta-devtools open --mcp",
                ]),
              ]),
            ]
          : []),
        el("dt", {}, ["Project workspace"]),
        el("dd", {}, [
          el("div", { class: "att-mono" }, [
            "invokta-devtools serve dist/engine.js",
          ]),
          el("div", {}, ["or yarn devtools inside an engine repo"]),
        ]),
      ]),
    ]);
    formHost.append(form, orientation);
  };

  paintForm();
  const card = el("div", { class: "att-card att-idle" }, [intro, formHost]);
  const retained = retainedActivityOf(options.state);
  if (retained.length === 0) return card;
  return el("div", {}, [
    card,
    el(
      "section",
      {
        class: "att-card att-view att-retained",
        "aria-label": "Activity retained from the disconnected target",
      },
      [
        el("div", { class: "att-section-heading" }, [
          el("div", {}, [
            el("h2", {}, ["Last session activity"]),
            el("span", { class: "att-hint" }, [
              "CLI verbs retained from the disconnected target",
            ]),
          ]),
        ]),
        cliActivityTable(retained),
      ],
    ),
  ]);
}

export function createCliUnavailableView(
  state: CliConnectionState,
): HTMLElement {
  const label =
    state.state === "connecting"
      ? "A connection is being established."
      : state.state === "closing"
        ? "The current connection is closing."
        : "A target is connected in another local browser session.";
  return el("section", { class: "att-card att-view" }, [
    el("p", { class: "att-kicker" }, ["Connection"]),
    el("h2", {}, ["Target slot unavailable"]),
    el("p", { class: "att-hint" }, [label]),
  ]);
}
