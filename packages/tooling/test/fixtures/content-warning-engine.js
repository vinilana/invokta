import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

export const engine = createEngine({
  name: "content-warning-engine",
  version: "0.1.0",
  capabilities: {
    "media.render": defineCapability({
      description: "Declares close-but-unsupported content annotations.",
      input: z.object({}),
      output: z.object({
        chart: z
          .string()
          .meta({ contentEncoding: "base64", contentMediaType: "image/jpg" }),
        frames: z.array(
          z
            .string()
            .meta({ contentEncoding: "base64", contentMediaType: "image/png" }),
        ),
      }),
      access: "public",
      async run() {
        return { chart: "", frames: [] };
      },
    }),
  },
});
