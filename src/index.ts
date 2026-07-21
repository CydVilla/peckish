#!/usr/bin/env node
/**
 * Peckish — chat with an AI ordering agent for DoorDash in your terminal.
 *
 *   $ npm run dev
 *   you › Find me a high-protein dinner under $25 that can arrive within
 *         45 minutes. Avoid mushrooms and excessive fees.
 *
 * Ctrl+C stops the current turn (history rolls back); Ctrl+C at the prompt exits.
 */
import { createInterface } from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import {
  runTurn,
  buildSessionContext,
  MODEL,
  EFFORT,
  TurnAborted,
  getSessionUsage,
  resetSessionUsage,
  type ChatMessage,
  type TurnUsageReport,
} from "./agent.js";
import { getDefaultAddress, openCartsLine, DdCliError, resolveDdCliPath } from "./ddcli.js";
import { registerTerminalProviders } from "./confirm.js";
import { listPreferences, preferencesFilePath } from "./prefs.js";
import { formatCost } from "./costs.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

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
  console.log(
    bold("\n🍜 Peckish") +
      dim(`  ·  ${MODEL} @ ${EFFORT} effort  ·  dd-cli @ ${resolveDdCliPath()}`),
  );
  process.stdout.write(dim("checking DoorDash sign-in… "));
  const [addressLine, cartsLine] = await Promise.all([preflight(), openCartsLine()]);
  console.log(green("ok"));
  if (addressLine) console.log(dim(`delivering to: ${addressLine}`));
  if (cartsLine !== "none" && cartsLine !== "unknown")
    console.log(dim(`open carts: ${cartsLine}`));
  const prefs = listPreferences();
  if (prefs.length)
    console.log(dim(`preferences loaded: ${prefs.length} (${preferencesFilePath()})`));
  console.log(
    dim(
      'try: "Find me a high-protein dinner under $25 that can arrive within 45 minutes. Avoid mushrooms and excessive fees."\n' +
        "commands: /prefs  /cost  /reset  /quit   ·   Ctrl+C stops a running turn   ·   audit log: ~/.peckish/logs/\n",
    ),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  registerTerminalProviders(rl);

  let currentTurn: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (currentTurn) {
      currentTurn.abort();
      process.stdout.write(dim("  (stopping…)"));
    } else {
      rl.close();
    }
  });

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sessionContext = buildSessionContext({
    defaultAddressLine: addressLine,
    timezone,
    openCartsLine: cartsLine,
  });

  let history: ChatMessage[] = [];
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
        resetSessionUsage();
        console.log(dim("conversation + cost meter cleared"));
        return ask();
      }
      if (input === "/prefs") {
        const notes = listPreferences();
        console.log(notes.length ? notes.map((n) => `  - ${n}`).join("\n") : dim("  (none saved)"));
        return ask();
      }
      if (input === "/cost") {
        const { usage, costUsd } = getSessionUsage();
        console.log(
          dim(
            `session ${formatCost(costUsd)}  ·  in ${usage.input_tokens.toLocaleString()} / cached ${usage.cache_read_input_tokens.toLocaleString()} / out ${usage.output_tokens.toLocaleString()} tokens  ·  ${MODEL}`,
          ),
        );
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

      currentTurn = new AbortController();
      let usageReport: TurnUsageReport | null = null;
      try {
        await runTurn(
          history,
          {
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
            onNotice: (message) => {
              freshLine();
              console.log(amber(`⚠ ${message}`));
            },
            onTurnUsage: (report) => {
              usageReport = report;
            },
          },
          { signal: currentTurn.signal },
        );
        freshLine();
        if (usageReport) {
          const r: TurnUsageReport = usageReport;
          console.log(
            dim(`${formatCost(r.turnCostUsd)} turn · ${formatCost(r.sessionCostUsd)} session`),
          );
        }
      } catch (err) {
        freshLine();
        if (err instanceof TurnAborted) {
          console.log(amber("✗ stopped — that turn was rolled back; ask again anytime"));
        } else if (
          err instanceof Anthropic.AuthenticationError ||
          /could not resolve authentication/i.test(err instanceof Error ? err.message : "")
        ) {
          console.error(
            red("✗ Anthropic authentication failed.") +
              "\n  Set ANTHROPIC_API_KEY in your environment (or sign in with `ant auth login`).",
          );
          while (history.length && history[history.length - 1].role === "user") history.pop();
        } else if (err instanceof Anthropic.APIError) {
          console.error(red(`✗ Claude API error ${err.status ?? ""}: ${err.message}`));
          while (history.length && history[history.length - 1].role === "user") history.pop();
        } else {
          console.error(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          while (history.length && history[history.length - 1].role === "user") history.pop();
        }
      } finally {
        currentTurn = null;
      }
      freshLine();
      ask();
    });
  };

  rl.on("close", () => {
    const { costUsd } = getSessionUsage();
    console.log(dim(`\nbye 👋  (session ${formatCost(costUsd)})`));
    process.exit(0);
  });
  ask();
}

main().catch((err) => {
  console.error(red(`fatal: ${err?.stack ?? err}`));
  process.exit(1);
});
