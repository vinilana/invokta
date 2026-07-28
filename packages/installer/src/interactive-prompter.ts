export interface PromptOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
}

export type PromptOutcome<Value> =
  | { readonly kind: "submitted"; readonly value: Value }
  | { readonly kind: "cancelled" };

interface ChoicePrompt<Value extends string> {
  readonly message: string;
  readonly options: readonly PromptOption<Value>[];
  readonly maxItems?: number;
}

export interface AutocompletePrompt<Value extends string>
  extends ChoicePrompt<Value> {
  readonly placeholder?: string;
  readonly initialValue?: Value;
}

export interface SelectPrompt<Value extends string>
  extends ChoicePrompt<Value> {
  readonly initialValue?: Value;
}

export interface MultiselectPrompt<Value extends string>
  extends ChoicePrompt<Value> {
  readonly initialValues?: readonly Value[];
}

export interface InteractiveSpinner {
  readonly start: (message?: string) => void;
  readonly stop: (message?: string) => void;
  readonly cancel: (message?: string) => void;
  readonly error: (message?: string) => void;
  readonly message: (message?: string) => void;
  readonly clear: () => void;
}

export type InteractiveLogLevel =
  | "info"
  | "success"
  | "step"
  | "warn"
  | "error";

/**
 * Internal, renderer-neutral interaction boundary. No Clack type or symbol may
 * cross it.
 */
export interface InteractivePrompter {
  readonly intro: (title: string) => void;
  readonly outro: (message: string) => void;
  readonly cancel: (message: string) => void;
  readonly autocomplete: <Value extends string>(
    prompt: AutocompletePrompt<Value>,
  ) => Promise<PromptOutcome<Value>>;
  readonly select: <Value extends string>(
    prompt: SelectPrompt<Value>,
  ) => Promise<PromptOutcome<Value>>;
  readonly multiselect: <Value extends string>(
    prompt: MultiselectPrompt<Value>,
  ) => Promise<PromptOutcome<readonly Value[]>>;
  readonly note: (message: string, title?: string) => void;
  readonly confirm: (message: string) => Promise<PromptOutcome<boolean>>;
  readonly spinner: () => InteractiveSpinner;
  readonly log: (level: InteractiveLogLevel, message: string) => void;
}
