import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";
import { serveMcpHttp, serveMcpStdio } from "../../dist/index.js";

const chart = Buffer.from("chart png bytes").toString("base64");
const voice = Buffer.from("voice wav bytes").toString("base64");

const engine = createEngine({
  name: "rich-content-engine",
  version: "0.1.0",
  capabilities: {
    "media.render": defineCapability({
      description: "Returns annotated image, audio, and link content.",
      input: z.object({ caption: z.string() }),
      output: z.object({
        caption: z.string(),
        chart: z
          .string()
          .meta({ contentEncoding: "base64", contentMediaType: "image/png" }),
        voice: z.object({
          mimeType: z.enum(["audio/wav", "audio/mpeg"]),
          data: z.base64(),
        }),
        report: z.object({
          uri: z.httpUrl().meta({ contentMediaType: "text/uri-list" }),
          name: z.string(),
          mimeType: z.string().optional(),
        }),
      }),
      access: "public",
      async run({ input }) {
        return {
          caption: input.caption,
          chart,
          voice: { mimeType: "audio/wav", data: voice },
          report: {
            uri: "https://reports.example/q3.pdf",
            name: "q3-report",
            mimeType: "application/pdf",
          },
        };
      },
    }),
    "media.plain": defineCapability({
      description: "Returns base64 data without a declared media type.",
      input: z.object({}),
      output: z.object({ data: z.base64() }),
      access: "public",
      async run() {
        return { data: chart };
      },
    }),
  },
});

if (process.argv[2] === "http") {
  const server = await serveMcpHttp(engine, {
    port: 0,
    auth: { mode: "dangerously-disabled-for-development" },
  });
  process.stdout.write(`${JSON.stringify(server.address())}\n`);
} else {
  await serveMcpStdio(engine);
}
