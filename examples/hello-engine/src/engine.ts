import { createEngine, type Principal } from "@invokta/core";

import {
  createWelcomeMessage,
  type GreetingWriter,
} from "./capabilities/create-welcome-message.js";

export const localPrincipal: Principal = Object.freeze({
  id: "local:hello-engine",
});

const templateGreetingWriter: GreetingWriter = {
  async write({ name, signal }) {
    signal.throwIfAborted();
    return `Hello, ${name}! Welcome to your first Action Engine.`;
  },
};

export function createHelloEngine(
  writer: GreetingWriter = templateGreetingWriter,
) {
  return createEngine({
    name: "hello-engine",
    version: "0.1.0",
    capabilities: {
      "onboarding.create-welcome-message": createWelcomeMessage(writer),
    },
  });
}

export const engine = createHelloEngine();
