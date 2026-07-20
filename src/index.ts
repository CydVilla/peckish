#!/usr/bin/env node
/**
 * Peckish — chat with an AI ordering agent for DoorDash in your terminal.
 *
 *   $ npm run dev
 *   you › Find me a high-protein dinner under $25 that can arrive within
 *         45 minutes. Avoid mushrooms and excessive fees.
 */
import { createInterface } from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { runTurn, buildSessionContext, MODEL } from "./agent.js";
import { getDefaultAddress, DdCliError, resolveDdCliPath } from "./ddcli.js";
import { registerTerminalProviders } from "./confirm.js";
import { listPreferences, preferencesFilePath } from "./prefs.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function nowStamp(): string {
  return new Date().toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

async function preflight(): Promise<string | null> {
  try {
    const def = await getDefaultAddress();
    if (!def) return null;
    const label = def.label ? `"${def.label}" — ` : "";
    return `${label}${def.printable_address}`;
  } catch (err) {
    if (err instanceof DdCliError) {
      console.error(red(`\n✗ ${err.message}`));
      if (err.detail) console.error(dim(err.detail.slice(0, 300)));
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(bold("\n🍜 Peckish") + dim(`  ·  ${MODEL}  ·  dd-cli @ ${resolveDdCliPath()}`));
  process.stdout.write(dim("checking DoorDash sign-in… "));
  const addressLine = await preflight();
  console.log(green("ok"));
  if (addressLine) console.log(dim(`delivering to: ${addressLine}`));
  const prefs = listPreferences();
  if (prefs.length) console.log(dim(`preferences loaded: ${prefs.length} (${preferencesFilePath()})`));
  console.log(
    dim(
      'try: "Find me a high-protein dinner under $25 that can arrive within 45 minutes. Avoid mushrooms and excessive fees."\n' +
        "commands: /prefs  /reset  /quit\n",
    ),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  registerTerminalProviders(rl);

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sessionContext = buildSessionContext({ defaultAddressLine: addressLine, timezone });

  let history: Anthropic.MessageParam[] = [];
  let firstTurn = true;

  const ask = (): void => {
    rl.question(bold("\nyou › "), async (line) => {
      const input = line.trim();
      if (!input) return ask();
      if (input === "/quit" || input === "/exit") {
        rl.close();
        return;
      }
      if (input === "/reset") {
        history = [];
        firstTurn = true;
        console.log(dim("conversation cleared"));
        return ask();
      }
      if (input === "/prefs") {
        const notes = listPreferences();
        console.log(notes.length ? notes.map((n) => `  - ${n}`).join("\n") : dim("  (none saved)"));
        return ask();
      }

      const stamped = `[${nowStamp()}] ${input}`;
      history.push({
        role: "user",
        content: firstTurn ? `${sessionContext}\n\n${stamped}` : stamped,
      });
      firstTurn = false;

      // Rendering state: keep tool/status lines on their own lines.
      let midText = false;
      const freshLine = () => {
        if (midText) {
          process.stdout.write("\n");
          midText = false;
        }
      };

      try {
        await runTurn(history, {
          onThinking: () => {
            freshLine();
            process.stdout.write(dim("· thinking…\n"));
          },
          onText: (delta) => {
            if (!midText) process.stdout.write("\n");
            midText = true;
            process.stdout.write(delta);
          },
          onToolStart: (name, input) => {
            freshLine();
            const preview = JSON.stringify(input);
            process.stdout.write(
              dim(`⚙ ${name} ${preview.length > 110 ? preview.slice(0, 110) + "…" : preview}`),
            );
          },
          onToolEnd: (_name, ok, ms) => {
            process.stdout.write(dim(`  ${ok ? "✓" : "✗"} ${(ms / 1000).toFixed(1)}s\n`));
          },
        });
      } catch (err) {
        freshLine();
        if (
          err instanceof Anthropic.AuthenticationError ||
          /could not resolve authentication/i.test(err instanceof Error ? err.message : "")
        ) {
          console.error(
            red("✗ Anthropic authentication failed.") +
              "\n  Set ANTHROPIC_API_KEY in your environment (or sign in with `ant auth login`).",
          );
        } else if (err instanceof Anthropic.APIError) {
          console.error(red(`✗ Claude API error ${err.status ?? ""}: ${err.message}`));
        } else {
          console.error(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        }
        // Drop the failed turn's trailing user message so history stays valid.
        while (history.length && history[history.length - 1].role === "user") history.pop();
      }
      freshLine();
      ask();
    });
  };

  rl.on("close", () => {
    console.log(dim("\nbye 👋"));
    process.exit(0);
  });
  ask();
}

main().catch((err) => {
  console.error(red(`fatal: ${err?.stack ?? err}`));
  process.exit(1);
});
