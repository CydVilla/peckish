#!/usr/bin/env node
/**
 * Peckish web — a local web chat UI over the same agent + tool layer.
 *
 * Single-user, localhost-only by design: your Mac is the backend (dd-cli auth
 * lives in your keychain). The browser gets an SSE stream of the turn
 * (text deltas, tool activity, result cards, usage/cost) and renders the order
 * gate as a modal — approving it resolves the same confirmation providers the
 * terminal uses. A Stop button aborts the running turn (history rolls back).
 *
 *   npm run web   →  http://localhost:4747
 */
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
} from "./agent.js";
import { getDefaultAddress, openCartsLine, resolveDdCliPath, DdCliError } from "./ddcli.js";
import { setConfirmationProviders } from "./confirm.js";
import { logEvent } from "./logger.js";
import { listPreferences } from "./prefs.js";
import { formatCost } from "./costs.js";

const PORT = Number(process.env.PECKISH_PORT || 4747);
const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "public", "index.html");

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

const sseClients = new Set<ServerResponse>();

function broadcast(event: Record<string, unknown>): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n");
}, 25_000).unref();

// ---------------------------------------------------------------------------
// Confirmation gate → browser modal
// ---------------------------------------------------------------------------

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const pendingConfirms = new Map<string, (approved: boolean) => void>();

function requestBrowserConfirmation(kind: "order" | "action", summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      broadcast({ type: "confirm_resolved", id, approved: false, timed_out: true });
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(id, (approved) => {
      clearTimeout(timer);
      pendingConfirms.delete(id);
      broadcast({ type: "confirm_resolved", id, approved });
      resolve(approved);
    });
    broadcast({ type: "confirm_request", id, kind, summary });
  });
}

setConfirmationProviders({
  order: (summary) => requestBrowserConfirmation("order", summary),
  action: (summary) => requestBrowserConfirmation("action", summary),
});

// ---------------------------------------------------------------------------
// Conversation state (single local user)
// ---------------------------------------------------------------------------

let history: ChatMessage[] = [];
let firstTurn = true;
let busy = false;
let currentTurn: AbortController | null = null;
let sessionContext: string | null = null;
let addressLine: string | null = null;
let bootCartsLine = "unknown";

/** Tools whose results the UI renders as rich cards (clipped for safety). */
const CARD_TOOLS = new Set(["search_restaurants", "preview_order", "get_order_history", "list_carts"]);

function resultPreview(name: string, result?: string): unknown {
  if (!result || !CARD_TOOLS.has(name)) return undefined;
  if (result.length > 20_000) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

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

async function handleMessage(text: string): Promise<void> {
  busy = true;
  currentTurn = new AbortController();
  broadcast({ type: "turn_start" });
  if (!sessionContext) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    sessionContext = buildSessionContext({
      defaultAddressLine: addressLine,
      timezone,
      openCartsLine: bootCartsLine,
    });
  }
  const stamped = `[${nowStamp()}] ${text}`;
  history.push({
    role: "user",
    content: firstTurn ? `${sessionContext}\n\n${stamped}` : stamped,
  });
  firstTurn = false;
  logEvent("user_message", { chars: text.length });

  try {
    await runTurn(
      history,
      {
        onThinking: () => broadcast({ type: "thinking" }),
        onText: (delta) => broadcast({ type: "text", delta }),
        onToolStart: (name, input) => broadcast({ type: "tool_start", name, input }),
        onToolEnd: (name, ok, ms, result) =>
          broadcast({ type: "tool_end", name, ok, ms, preview: resultPreview(name, result) }),
        onNotice: (message) => broadcast({ type: "notice", message }),
        onTurnUsage: (report) =>
          broadcast({
            type: "usage",
            turn_cost: formatCost(report.turnCostUsd),
            session_cost: formatCost(report.sessionCostUsd),
          }),
      },
      { signal: currentTurn.signal },
    );
    broadcast({ type: "turn_done" });
  } catch (err) {
    if (err instanceof TurnAborted) {
      broadcast({ type: "aborted" });
      broadcast({ type: "turn_done" });
    } else {
      while (history.length && history[history.length - 1].role === "user") history.pop();
      const message =
        err instanceof Anthropic.AuthenticationError ||
        /could not resolve authentication/i.test(err instanceof Error ? err.message : "")
          ? "Anthropic authentication failed — set ANTHROPIC_API_KEY in the shell running `npm run web`, then restart it."
          : err instanceof Anthropic.APIError
            ? `Claude API error ${err.status ?? ""}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
      broadcast({ type: "error", message });
      broadcast({ type: "turn_done" });
    }
  } finally {
    busy = false;
    currentTurn = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Localhost-only guards: Host blocks DNS rebinding; Origin (when a browser
  // sends one) blocks cross-origin POSTs from other sites.
  const host = (req.headers.host ?? "").split(":")[0];
  if (!LOCAL_HOSTS.has(host)) {
    return json(res, 403, { error: "Peckish web only serves localhost" });
  }
  if (req.method === "POST" && req.headers.origin) {
    try {
      if (!LOCAL_HOSTS.has(new URL(req.headers.origin).hostname)) {
        return json(res, 403, { error: "cross-origin requests are not allowed" });
      }
    } catch {
      return json(res, 403, { error: "invalid Origin" });
    }
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(INDEX_HTML));
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        model: MODEL,
        effort: EFFORT,
        address: addressLine,
        preferences: listPreferences(),
        busy,
        session_cost: formatCost(getSessionUsage().costUsd),
        dd_cli: resolveDdCliPath(),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/message") {
      if (busy) return json(res, 409, { error: "a turn is already running" });
      const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "empty message" });
      void handleMessage(text);
      return json(res, 202, { accepted: true });
    }

    if (req.method === "POST" && url.pathname === "/api/abort") {
      if (!busy || !currentTurn) return json(res, 409, { error: "no turn running" });
      currentTurn.abort();
      return json(res, 202, { stopping: true });
    }

    if (req.method === "POST" && url.pathname === "/api/confirm") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        id?: string;
        approved?: boolean;
      };
      const resolver = body.id ? pendingConfirms.get(body.id) : undefined;
      if (!resolver) return json(res, 404, { error: "no such pending confirmation" });
      resolver(body.approved === true);
      return json(res, 200, { ok: true });
    }

    // Debug-only: exercise the confirmation modal without a live model turn.
    // Enabled by PECKISH_DEBUG=1; never touches dd-cli.
    if (
      process.env.PECKISH_DEBUG === "1" &&
      req.method === "POST" &&
      url.pathname === "/api/_test_confirm"
    ) {
      const approved = await requestBrowserConfirmation(
        "order",
        "TEST — Sharon Korean Kitchen\n1× Grilled Chicken Bulgogi Bowl — $16.95\nTotal (before tip): $21.40\nTip: $3.50 · Visa ···· 1234\nETA 20–30 min",
      );
      return json(res, 200, { approved });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (busy) return json(res, 409, { error: "a turn is already running" });
      history = [];
      firstTurn = true;
      resetSessionUsage();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

try {
  const [def, carts] = await Promise.all([getDefaultAddress(), openCartsLine()]);
  if (def) {
    const label = def.label ? `"${def.label}" — ` : "";
    addressLine = `${label}${def.printable_address}`;
  }
  bootCartsLine = carts;
  console.log(`✓ DoorDash sign-in ok${addressLine ? ` (${addressLine})` : ""}`);
  if (carts !== "none" && carts !== "unknown") console.log(`  open carts: ${carts}`);
} catch (err) {
  if (err instanceof DdCliError) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  throw err;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`🍜 Peckish web → http://localhost:${PORT}  (model: ${MODEL} @ ${EFFORT} effort)`);
});
