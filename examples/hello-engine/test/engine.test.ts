import { describe, expect, it, vi } from "vitest";

import type { GreetingWriter } from "../src/capabilities/create-welcome-message.js";
import { createHelloEngine } from "../src/engine.js";

describe("hello engine", () => {
  it("creates a welcome message through an injected domain dependency", async () => {
    const write = vi.fn<GreetingWriter["write"]>(async ({ name }) =>
      Promise.resolve(`Welcome, ${name}.`),
    );
    const engine = createHelloEngine({ write });

    const result = await engine.invoke(
      "onboarding.create-welcome-message",
      { name: "  Ada  " },
      { principal: { id: "test:user" } },
    );

    expect(result).toEqual({ message: "Welcome, Ada." });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({ name: "Ada" });
    expect(write.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("denies an anonymous caller before invoking the dependency", async () => {
    const write = vi.fn<GreetingWriter["write"]>();
    const engine = createHelloEngine({ write });

    await expect(
      engine.invoke("onboarding.create-welcome-message", { name: "Ada" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects invalid input before invoking the dependency", async () => {
    const write = vi.fn<GreetingWriter["write"]>();
    const engine = createHelloEngine({ write });

    await expect(
      engine.invoke(
        "onboarding.create-welcome-message",
        { name: "   " },
        { principal: { id: "test:user" } },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects an invalid result from the injected dependency", async () => {
    const engine = createHelloEngine({
      async write() {
        return "";
      },
    });

    await expect(
      engine.invoke(
        "onboarding.create-welcome-message",
        { name: "Ada" },
        { principal: { id: "test:user" } },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });
});
