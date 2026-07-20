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

const CANDIDATE_PATHS = [
  process.env.DD_CLI_PATH,
  join(homedir(), ".local", "bin", "dd-cli"),
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

function stripUiFields(value: unknown): unknown {
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
          if (/missing credentials|sign in with dd-cli login|token has expired/i.test(detail)) {
            reject(
              new DdCliError(
                "DoorDash sign-in is missing or expired. The user must run `dd-cli login` in a separate terminal, then retry.",
                detail,
              ),
            );
          } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new DdCliError(
                `dd-cli binary not found (looked for: ${DD_CLI}). Install it and/or set DD_CLI_PATH.`,
              ),
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors observed to be transient backend/CLI hiccups worth one retry. */
function isTransient(err: unknown): boolean {
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
  const { stdout } = await execDd(["--json-output", ...args]);
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
  const { stdout } = await execDd([...args, "--beautify"]);
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
