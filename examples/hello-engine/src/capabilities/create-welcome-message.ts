import { defineCapability } from "@invokta/core";
import { z } from "zod";

export interface GreetingWriter {
  write(args: {
    readonly name: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export function createWelcomeMessage(writer: GreetingWriter) {
  return defineCapability({
    title: "Create a welcome message",
    description: "Creates a short welcome message for a new team member.",
    input: z.object({ name: z.string().trim().min(1) }),
    output: z.object({ message: z.string().min(1) }),
    access: "authenticated",
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input, context }) {
      return {
        message: await writer.write({
          name: input.name,
          signal: context.signal,
        }),
      };
    },
  });
}
