/**
 * Typed subprocess wrapper around the DoorDash CLI (dd-cli).
 *
 * Every call shells out via execFile (no shell interpolation), parses the
 * MCP-shaped JSON envelope {content, structuredContent, isError}, and returns
 * only the structured payload — with widget/assistant-instruction fields
 * stripped, since this app renders a terminal, not DoorDash's widget UI, and
 * server-supplied "instructions" must never steer the model.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { installHint, signinHint } from "./platform.js";

const CANDIDATE_PATHS = [
  process.env.DD_CLI_PATH,
  join(homedir(), ".local", "bin", "dd-cli"), // install.sh's target on macOS and Linux
  "/usr/local/bin/dd-cli", // container images that drop the binary in system-wide
  "dd-cli", // rely on PATH as last resort
].filter((p): p is string => Boolean(p));

export function resolveDdCliPath(): string {
  for (const p of CANDIDATE_PATHS) {
    if (p === "dd-cli" || existsSync(p)) return p;
  }
  return "dd-cli";
}

const DD_CLI = resolveDdCliPath();
const TIMEOUT_MS = 90_000;
const MAX_BUFFER = 32 * 1024 * 1024; // menus can be large

/** Keys that carry UI-rendering or model-steering content we must drop. */
const STRIPPED_KEYS = new Set(["widget_type", "assistant_instructions"]);

export function stripUiFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUiFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRIPPED_KEYS.has(k)) continue;
      out[k] = stripUiFields(v);
    }
    return out;
  }
  return value;
}

export class DdCliError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "DdCliError";
  }
}

function execDd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      DD_CLI,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stdout}\n${stderr}`.trim();
          if (
            /missing credentials|sign in with dd-cli login|token has expired|failed to authenticate|try running dd-cli login|DD_CLI_ACCESS_TOKEN|invalid access token/i.test(
              detail,
            )
          ) {
            // The fix differs per environment: browser login on a desktop,
            // an injected DD_CLI_ACCESS_TOKEN in a headless container.
            reject(
              new DdCliError(`DoorDash sign-in is missing or expired. ${signinHint()}`, detail),
            );
          } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new DdCliError(`dd-cli binary not found (looked for: ${DD_CLI}). ${installHint()}`),
            );
          } else if (err.killed) {
            reject(new DdCliError(`dd-cli timed out after ${TIMEOUT_MS / 1000}s`, detail));
          } else {
            reject(new DdCliError(`dd-cli exited with an error`, detail || err.message));
          }
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Intent (dd-cli ≥0.2.1 requires --intent on every consumer command).
//
// PRIVACY DEFAULT: dd-cli's documented format asks for the user's VERBATIM
// prompt, which DoorDash may review. Food prompts routinely carry dietary,
// health, and religious signals — exactly what DoorDash's own guidance says
// to avoid — so Peckish sends a short goal summary and explicitly withholds
// the verbatim line unless PECKISH_INTENT_VERBATIM=1 is set. Documented in
// the README; the model is instructed to keep summaries constraint-free.
// ---------------------------------------------------------------------------

/** Sequential-dispatch call context; set by the tool dispatcher per call. */
let currentIntent: string | null = null;

export function setCallIntent(intent: string | null): void {
  currentIntent = intent && intent.trim() ? intent.trim() : null;
}

export const INTENT_VERBATIM = process.env.PECKISH_INTENT_VERBATIM === "1";

const FALLBACK_INTENT = "Operate the Peckish food-ordering app for its signed-in user.";

export function formatIntent(raw: string | null): string {
  const value = (raw ?? "").trim() || FALLBACK_INTENT;
  if (/user prompt\/purpose:/i.test(value)) {
    // Verbatim mode: the model already produced the full two-line format.
    return /^summary:/i.test(value) ? value : `Summary: ${value}`;
  }
  const summary = value.replace(/^summary:\s*/i, "");
  return `Summary: ${summary}\nuser prompt/purpose: "(not shared — Peckish privacy default)"`;
}

/** Commands that do not accept --intent. */
const NO_INTENT_COMMANDS = new Set(["login"]);

function withIntent(args: string[]): string[] {
  if (args.length && NO_INTENT_COMMANDS.has(args[0])) return args;
  if (args.includes("--intent")) return args;
  return [...args, "--intent", formatIntent(currentIntent)];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors observed to be transient backend/CLI hiccups worth one retry. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof DdCliError)) return false;
  const text = `${err.message} ${err.detail ?? ""}`;
  if (/sign-in is missing|binary not found/i.test(text)) return false;
  return /Input validation error|session_id|timed out|temporarily|try again|50\d/i.test(text);
}

/**
 * Run a dd-cli command with --json-output and return the sanitized
 * structuredContent payload. Throws DdCliError on failure.
 *
 * `retryOnce` must be set ONLY for read-only commands — mutations (cart adds,
 * promo apply, order submit) are not idempotent and must never auto-retry.
 */
export async function ddJson(
  args: string[],
  opts: { retryOnce?: boolean } = {},
): Promise<Record<string, unknown>> {
  try {
    return await ddJsonOnce(args);
  } catch (err) {
    if (opts.retryOnce && isTransient(err)) {
      await sleep(1500);
      return ddJsonOnce(args);
    }
    throw err;
  }
}

async function ddJsonOnce(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execDd(["--json-output", ...withIntent(args)]);
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new DdCliError("dd-cli returned non-JSON output", stdout.slice(0, 2000));
  }
  const env = envelope as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  let payload = env.structuredContent;
  if (!payload && env.content?.length) {
    // Fallback: some responses may only carry stringified JSON in content[]
    const text = env.content.find((c) => c.type === "text")?.text;
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { message: text };
      }
    }
  }
  if (!payload) throw new DdCliError("dd-cli returned an empty response");
  const clean = stripUiFields(payload) as Record<string, unknown>;
  if (env.isError) clean._cli_is_error = true;
  return clean;
}

/** Run a dd-cli command in --beautify mode and return the plain text. */
export async function ddBeautify(args: string[]): Promise<string> {
  const { stdout } = await execDd([...withIntent(args), "--beautify"]);
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Typed accessors used outside the tool layer
// ---------------------------------------------------------------------------

export interface SavedAddress {
  address_id: string;
  printable_address: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  lat: number;
  lng: number;
  is_default: boolean;
  label: string | null;
}

export async function listAddresses(): Promise<SavedAddress[]> {
  const res = await ddJson(["address", "list"], { retryOnce: true });
  return (res.addresses as SavedAddress[]) ?? [];
}

export async function getDefaultAddress(): Promise<SavedAddress | null> {
  const addresses = await listAddresses();
  return addresses.find((a) => a.is_default) ?? null;
}

/** One-line summary of open carts for the session context (best-effort). */
export async function openCartsLine(): Promise<string> {
  try {
    const res = await ddJson(["cart", "list"], { retryOnce: true });
    const carts = (res.carts as Array<Record<string, unknown>>) ?? [];
    if (!carts.length) return "none";
    return carts
      .map((c) => {
        const updated =
          typeof c.updated_at === "number"
            ? `updated ${new Date(c.updated_at).toISOString().slice(0, 10)}`
            : "age unknown";
        return `${c.store_name ?? c.store_id} — ${c.items_count ?? "?"} item(s), ${updated} (cart_uuid ${c.cart_uuid})`;
      })
      .join("; ");
  } catch {
    return "unknown";
  }
}
