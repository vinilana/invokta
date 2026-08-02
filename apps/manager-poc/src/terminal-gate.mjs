/**
 * The authorization boundary of this proof of concept.
 *
 * The browser can propose a change; it can never authorize one. Every mutation
 * pauses here and waits for an explicit confirmation typed into the terminal
 * that started the console. That keeps the property ADR 0010 and ADR 0013 rely
 * on — a configuration write always follows a deliberate TTY confirmation —
 * while still allowing a much better browsing and selection experience.
 *
 * A page opened by another local process, a stale tab, or a cross-site request
 * therefore cannot change a single byte of client configuration on its own.
 */

import { createInterface } from "node:readline";

const styles = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  green: "\u001b[32m",
};

function paint(enabled, style, text) {
  return enabled ? `${styles[style]}${text}${styles.reset}` : text;
}

export function createTerminalGate({ input, output, colors }) {
  let queue = Promise.resolve();

  async function ask(request) {
    output.write("\n");
    output.write(
      `${paint(colors, "cyan", "▌")} ${paint(colors, "bold", request.title)}\n`,
    );
    for (const line of request.lines) {
      output.write(
        `${paint(colors, "cyan", "▌")} ${paint(colors, "dim", line)}\n`,
      );
    }
    if (request.warning !== undefined) {
      output.write(
        `${paint(colors, "cyan", "▌")} ${paint(colors, "yellow", request.warning)}\n`,
      );
    }
    output.write(`${paint(colors, "cyan", "▌")}\n`);

    const rl = createInterface({ input, output });
    try {
      const answer = await new Promise((resolve) => {
        rl.question(
          `${paint(colors, "cyan", "▌")} Apply this change? ${paint(colors, "dim", "(y/N)")} `,
          resolve,
        );
      });
      const approved = /^y(es)?$/iu.test(answer.trim());
      output.write(
        approved
          ? `${paint(colors, "green", "▌ approved")}\n\n`
          : `${paint(colors, "red", "▌ declined")}\n\n`,
      );
      return approved;
    } finally {
      rl.close();
    }
  }

  return {
    /** Serialized so two browser tabs cannot interleave two prompts. */
    request(request) {
      const result = queue.then(() => ask(request));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
