/** Creates the first local OAuth owner without a public sign-up endpoint. */
import "../env.js";

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { Pool } from "pg";

import {
  databasePoolConfig,
  requireDatabaseConfiguration,
} from "../database/config.js";
import { reportStartupFailure } from "../env.js";
import { OAuthUserStore } from "./user-store.js";

function hiddenInput(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const value = process.env.INVOKTA_OAUTH_BOOTSTRAP_PASSWORD;
    if (value === undefined || value === "") {
      return Promise.reject(
        new Error(
          "INVOKTA_OAUTH_BOOTSTRAP_PASSWORD is required without an interactive terminal.",
        ),
      );
    }
    return Promise.resolve(value);
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Owner bootstrap was cancelled."));
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  requireDatabaseConfiguration();
  const reader = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email =
      process.env.INVOKTA_OAUTH_BOOTSTRAP_EMAIL ??
      (await reader.question("Owner email: "));
  } finally {
    reader.close();
  }
  const password = await hiddenInput("Owner password: ");
  const confirmation = await hiddenInput("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("The password confirmation does not match.");
  }

  const pool = new Pool(databasePoolConfig());
  try {
    const account = await new OAuthUserStore(pool).createOwner(email, password);
    process.stdout.write(`OAuth owner created: ${account.email}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(reportStartupFailure);
