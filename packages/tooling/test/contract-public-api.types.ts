import type { Engine } from "@invokta/core";
import { expectTypeOf } from "vitest";

import {
  type ContractCapabilitySnapshot,
  type ContractChange,
  type ContractChangeSeverity,
  type ContractCommandIo,
  type ContractCommandOptions,
  type ContractDiff,
  type ContractSnapshot,
  createContractSnapshot,
  diffContractSnapshots,
  runContractCommand,
  serializeContractSnapshot,
} from "../src/index.js";

declare const engine: Engine;
declare const io: ContractCommandIo;

const snapshot = createContractSnapshot(engine);
expectTypeOf(snapshot).toEqualTypeOf<ContractSnapshot>();
expectTypeOf(snapshot.formatVersion).toEqualTypeOf<1>();
expectTypeOf<ContractCapabilitySnapshot["access"]>().toEqualTypeOf<
  "public" | "authenticated" | "function"
>();
expectTypeOf(serializeContractSnapshot(snapshot)).toEqualTypeOf<string>();

const diff = diffContractSnapshots(snapshot, snapshot);
expectTypeOf(diff).toEqualTypeOf<ContractDiff>();
expectTypeOf(diff.changes).toEqualTypeOf<readonly ContractChange[]>();
expectTypeOf<ContractChangeSeverity>().toEqualTypeOf<
  "breaking" | "potentially-breaking" | "compatible"
>();
expectTypeOf<ContractChange["schema"]>().toEqualTypeOf<
  "input" | "output" | undefined
>();

expectTypeOf(
  runContractCommand({
    argv: ["contract", "diff", "contract.json", "contract.next.json"],
    cwd: "/workspace/app",
    io,
  }),
).toEqualTypeOf<Promise<number>>();
expectTypeOf(runContractCommand()).toEqualTypeOf<Promise<number>>();

const options: ContractCommandOptions = {
  argv: ["contract", "snapshot", "dist/engine.js", "--output", "contract.json"],
};
expectTypeOf(options).toMatchTypeOf<ContractCommandOptions>();

// @ts-expect-error An argument vector is a list of arguments, not a command line.
runContractCommand({ argv: "contract snapshot dist/engine.js" });

// @ts-expect-error A snapshot has a fixed format version.
const futureSnapshot: ContractSnapshot = { ...snapshot, formatVersion: 2 };
void futureSnapshot;
