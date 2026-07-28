import { expectTypeOf } from "vitest";

import type {
  InstallerFileSystem,
  InstallerPathInspection,
  InstallerTransactionFileSystem,
} from "../src/file-system.js";
import type {
  ExecutableResolver,
  OperatingSystemHomeResolver,
  TargetConfigEvidenceProbes,
} from "../src/harness-detection.js";
import type {
  InteractivePrompter,
  PromptOutcome,
} from "../src/interactive-prompter.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import type {
  TargetAdapter,
  TargetAdapterCounters,
} from "../src/target-adapter.js";

declare const fileSystem: InstallerFileSystem;
declare const transactionFileSystem: InstallerTransactionFileSystem;
declare const prompter: InteractivePrompter;
declare const resolveExecutable: ExecutableResolver;
declare const resolveHomeDirectory: OperatingSystemHomeResolver;
declare const configEvidenceProbes: TargetConfigEvidenceProbes;
declare const targetAdapter: TargetAdapter;
declare const targetAdapterCounters: TargetAdapterCounters;
declare const installDescriptor: CapabilityInstallDescriptor;

expectTypeOf(
  fileSystem.readFile(new URL("file:///registry.json")),
).toEqualTypeOf<Promise<Uint8Array>>();
expectTypeOf(fileSystem.inspectPath("/users/tester/config.json")).toEqualTypeOf<
  Promise<InstallerPathInspection>
>();
expectTypeOf(
  transactionFileSystem.openReadNoFollow("/users/tester/config.json"),
).toMatchTypeOf<Promise<{ readAll(maxBytes: number): Promise<Uint8Array> }>>();
expectTypeOf(
  transactionFileSystem.createExclusiveNoFollow(
    "/users/tester/config.json.lock",
    0o600,
  ),
).toMatchTypeOf<
  Promise<{
    writeAll(bytes: Uint8Array): Promise<void>;
    chmod(mode: number): Promise<void>;
    chown(uid: number, gid: number): Promise<void>;
    sync(): Promise<void>;
  }>
>();

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

expectTypeOf(resolveHomeDirectory()).toEqualTypeOf<string>();
expectTypeOf(
  targetAdapter.inspect({
    source: new Uint8Array(),
    serverName: "support-engine",
    counters: targetAdapterCounters,
  }).currentServer,
).toMatchTypeOf<
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly definition: Readonly<Record<string, unknown>>;
    }
>();
expectTypeOf(
  targetAdapter.descriptorToDefinition(installDescriptor),
).toEqualTypeOf<Readonly<Record<string, unknown>>>();
expectTypeOf(resolveExecutable("codex")).toEqualTypeOf<
  Promise<
    | {
        readonly path: string;
        readonly identity: {
          readonly device: number;
          readonly inode: number;
          readonly realPath: string;
        };
        readonly legacyAliasFor?: "agy";
      }
    | undefined
  >
>();
expectTypeOf(
  configEvidenceProbes.codex({
    homeDirectory: "/users/tester",
    targetId: "codex",
  }),
).toEqualTypeOf<
  Promise<
    | { readonly kind: "present"; readonly path: string }
    | { readonly kind: "absent"; readonly path: string }
    | {
        readonly kind: "blocked";
        readonly code:
          | "HARNESS_CONFIG_UNSAFE"
          | "HARNESS_CONFIG_AMBIGUOUS"
          | "HARNESS_CONFIG_READ_FAILED"
          | "TARGET_UNSUPPORTED";
      }
  >
>();

// @ts-expect-error Clack cancellation symbols cannot cross the internal port.
const leakedCancellation: PromptOutcome<string> = Symbol("cancel");
expectTypeOf(leakedCancellation).toMatchTypeOf<PromptOutcome<string>>();
