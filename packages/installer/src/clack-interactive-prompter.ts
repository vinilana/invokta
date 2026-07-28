import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
} from "@clack/prompts";

import type {
  AutocompletePrompt,
  InteractivePrompter,
  MultiselectPrompt,
  PromptOption,
  PromptOutcome,
  SelectPrompt,
} from "./interactive-prompter.js";

function submitted<Value>(value: Value): PromptOutcome<Value> {
  return { kind: "submitted", value };
}

function cancelled<Value>(): PromptOutcome<Value> {
  return { kind: "cancelled" };
}

function options<Value extends string>(values: readonly PromptOption<Value>[]) {
  return values.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint === undefined ? {} : { hint: option.hint }),
    ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
  }));
}

async function autocompletePrompt<Value extends string>(
  prompt: AutocompletePrompt<Value>,
): Promise<PromptOutcome<Value>> {
  const value = await autocomplete<string>({
    message: prompt.message,
    options: options(prompt.options),
    ...(prompt.maxItems === undefined ? {} : { maxItems: prompt.maxItems }),
    ...(prompt.placeholder === undefined
      ? {}
      : { placeholder: prompt.placeholder }),
    ...(prompt.initialValue === undefined
      ? {}
      : { initialValue: prompt.initialValue }),
  });
  if (isCancel(value)) return cancelled();
  return submitted(value as Value);
}

async function selectPrompt<Value extends string>(
  prompt: SelectPrompt<Value>,
): Promise<PromptOutcome<Value>> {
  const value = await select<string>({
    message: prompt.message,
    options: options(prompt.options),
    ...(prompt.maxItems === undefined ? {} : { maxItems: prompt.maxItems }),
    ...(prompt.initialValue === undefined
      ? {}
      : { initialValue: prompt.initialValue }),
  });
  if (isCancel(value)) return cancelled();
  return submitted(value as Value);
}

async function multiselectPrompt<Value extends string>(
  prompt: MultiselectPrompt<Value>,
): Promise<PromptOutcome<readonly Value[]>> {
  const value = await multiselect<string>({
    message: prompt.message,
    options: options(prompt.options),
    required: true,
    ...(prompt.maxItems === undefined ? {} : { maxItems: prompt.maxItems }),
    ...(prompt.initialValues === undefined
      ? {}
      : { initialValues: [...prompt.initialValues] }),
  });
  if (isCancel(value)) return cancelled();
  return submitted(value as Value[]);
}

async function confirmPrompt(message: string): Promise<PromptOutcome<boolean>> {
  const value = await confirm({ message, initialValue: false });
  if (isCancel(value)) return cancelled();
  return submitted(value as boolean);
}

export function createClackInteractivePrompter(): InteractivePrompter {
  return {
    intro,
    outro,
    cancel,
    autocomplete: autocompletePrompt,
    select: selectPrompt,
    multiselect: multiselectPrompt,
    note,
    confirm: confirmPrompt,
    spinner: () => {
      const instance = spinner();
      return {
        start: (message) => instance.start(message),
        stop: (message) => instance.stop(message),
        cancel: (message) => instance.cancel(message),
        error: (message) => instance.error(message),
        message: (message) => instance.message(message),
        clear: () => instance.clear(),
      };
    },
    log: (level, message) => log[level](message),
  };
}
