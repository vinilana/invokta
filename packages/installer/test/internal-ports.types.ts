import { expectTypeOf } from "vitest";

import type { InstallerFileSystem } from "../src/file-system.js";
import type {
  InteractivePrompter,
  PromptOutcome,
} from "../src/interactive-prompter.js";

declare const fileSystem: InstallerFileSystem;
declare const prompter: InteractivePrompter;

expectTypeOf(
  fileSystem.readFile(new URL("file:///registry.json")),
).toEqualTypeOf<Promise<Uint8Array>>();

expectTypeOf(prompter.confirm("Apply changes?")).toEqualTypeOf<
  Promise<PromptOutcome<boolean>>
>();

expectTypeOf(
  prompter.autocomplete({
    message: "Choose",
    options: [{ value: "support-engine", label: "Support Engine" }],
  }),
).toEqualTypeOf<Promise<PromptOutcome<"support-engine">>>();

const submitted: PromptOutcome<string> = {
  kind: "submitted",
  value: "support-engine",
};
expectTypeOf(submitted).toMatchTypeOf<PromptOutcome<string>>();

// @ts-expect-error Clack cancellation symbols cannot cross the internal port.
const leakedCancellation: PromptOutcome<string> = Symbol("cancel");
expectTypeOf(leakedCancellation).toMatchTypeOf<PromptOutcome<string>>();
