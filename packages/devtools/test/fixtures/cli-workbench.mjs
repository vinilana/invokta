import { readFileSync, writeFileSync } from "node:fs";

const catalog = Object.freeze([
  {
    id: "fixture.echo",
    title: "Echo",
    description: "Echoes a value.",
    annotations: { readOnly: true },
  },
  {
    id: "fixture.ping",
    description: "Returns pong.",
  },
]);

const description = Object.freeze({
  id: "fixture.echo",
  title: "Echo",
  description: "Echoes a value.",
  annotations: { readOnly: true },
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  outputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
  },
  timeoutMs: 1_000,
});

function writeJson(value, pretty) {
  process.stdout.write(
    `${JSON.stringify(value, null, pretty === true ? 2 : undefined)}\n`,
  );
}

function parseArgv(argv) {
  let scenario = "ok";
  let countFile;
  let byteCount;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--scenario") {
      scenario = argv[index + 1] ?? "ok";
      index += 1;
      continue;
    }
    if (argument === "--count-file") {
      countFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--bytes") {
      byteCount = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    rest.push(argument);
  }
  const verb = rest[0];
  return { scenario, countFile, byteCount, verb, rest };
}

function nextCount(countFile) {
  if (countFile === undefined) return 1;
  let current = 0;
  try {
    current = Number(readFileSync(countFile, "utf8"));
  } catch {
    current = 0;
  }
  const next = current + 1;
  writeFileSync(countFile, String(next), "utf8");
  return next;
}

function summaries(count) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      id: `fixture.item-${String(index)}`,
      description: `Item ${String(index)}`,
    });
  }
  return items;
}

function writeExactBytes(bytes, payload) {
  const encoded = Buffer.from(payload, "utf8");
  if (encoded.length > bytes) {
    process.stdout.write(encoded.subarray(0, bytes));
    return;
  }
  process.stdout.write(encoded);
  if (encoded.length < bytes) {
    process.stdout.write(Buffer.alloc(bytes - encoded.length, 0x20));
  }
}

const parsed = parseArgv(process.argv.slice(2));
const { scenario, verb } = parsed;

if (scenario === "sleep") {
  setInterval(() => undefined, 60_000);
} else if (verb === "list") {
  if (scenario === "nonzero") {
    writeJson(catalog);
    process.exitCode = 1;
  } else if (scenario === "not-json") {
    process.stdout.write("not-json\n");
  } else if (scenario === "two-values") {
    process.stdout.write("[][]\n");
  } else if (scenario === "non-array") {
    writeJson({ id: "fixture.echo", description: "not an array" });
  } else if (scenario === "non-object-element") {
    writeJson([1]);
  } else if (scenario === "missing-id") {
    writeJson([{ description: "missing id" }]);
  } else if (scenario === "empty-id") {
    writeJson([{ id: "", description: "empty id" }]);
  } else if (scenario === "missing-description") {
    writeJson([{ id: "fixture.echo" }]);
  } else if (scenario === "bad-title") {
    writeJson([{ id: "fixture.echo", description: "d", title: 1 }]);
  } else if (scenario === "bad-annotations") {
    writeJson([{ id: "fixture.echo", description: "d", annotations: "x" }]);
  } else if (scenario === "oversize-catalog") {
    writeJson(summaries(2_001));
  } else if (scenario === "exact-2000") {
    writeJson(summaries(2_000));
  } else if (scenario === "oversize-stdout") {
    writeExactBytes((parsed.byteCount ?? 10 * 1024 * 1024) + 1, "[]\n");
  } else if (scenario === "exact-10mib") {
    writeExactBytes(parsed.byteCount ?? 10 * 1024 * 1024, "[]");
  } else if (scenario === "oversize-stderr") {
    process.stderr.write(
      Buffer.alloc((parsed.byteCount ?? 10 * 1024 * 1024) + 1, 0x78),
    );
    writeJson(catalog);
  } else if (scenario === "empty") {
    writeJson([]);
  } else if (scenario === "extra-props") {
    writeJson([
      {
        id: "fixture.echo",
        description: "Echoes a value.",
        owner: "must-be-ignored",
      },
    ]);
  } else if (scenario === "pretty") {
    writeJson(catalog, true);
  } else if (scenario === "duplicate-ids") {
    writeJson([
      { id: "fixture.echo", description: "first" },
      { id: "fixture.echo", description: "second" },
    ]);
  } else if (scenario === "empty-description") {
    writeJson([{ id: "fixture.echo", description: "" }]);
  } else if (scenario === "stderr-ok") {
    process.stderr.write("diagnostic on stderr\n");
    writeJson(catalog);
  } else if (scenario === "list-ok-then-fail") {
    const count = nextCount(parsed.countFile);
    writeJson(catalog);
    if (count >= 2) process.exitCode = 1;
  } else if (scenario === "inspect-env") {
    writeJson([
      {
        id: "fixture.env",
        description: "inspect",
      },
    ]);
  } else {
    writeJson(catalog);
  }
} else if (verb === "describe") {
  const id = parsed.rest[1] ?? "";
  if (scenario === "describe-fail") {
    process.exitCode = 1;
    writeJson({ error: { code: "NOT_FOUND" } });
  } else if (scenario === "describe-not-json") {
    process.stdout.write("not-json\n");
  } else if (scenario === "describe-bad-schema") {
    writeJson({ id, description: "missing schemas" });
  } else if (scenario === "describe-timeout") {
    setInterval(() => undefined, 60_000);
  } else if (scenario === "pretty") {
    writeJson({ ...description, id }, true);
  } else {
    writeJson({ ...description, id });
  }
} else if (verb === "run") {
  if (scenario === "run-ok") {
    const inputIndex = parsed.rest.indexOf("--input");
    const input =
      inputIndex === -1 ? "{}" : (parsed.rest[inputIndex + 1] ?? "{}");
    writeJson({ echoed: JSON.parse(input) });
  } else if (scenario === "run-fail") {
    process.exitCode = 1;
    writeJson({ error: { code: "EXECUTION_FAILED" } });
  } else if (scenario === "run-not-json") {
    process.stdout.write("not-json\n");
  } else {
    process.stderr.write("run is not implemented by this fixture\n");
    process.exitCode = 2;
  }
} else {
  process.stderr.write("unknown verb\n");
  process.exitCode = 2;
}
