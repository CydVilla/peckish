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
import { installHint, signinHint, parseVersion, compareVersions } from "./platform.js";

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

/**
 * Keys that never reach the model: UI-rendering and model-steering content,
 * plus `guest_token` — a bearer credential for one guest's sub-cart that
 * dd-cli's guidance says to keep server-side and out of logs. Peckish's audit
 * log previews every tool result, so stripping it here keeps it off disk too.
 * The one path that legitimately needs it reads the raw payload (ddJsonRaw)
 * and hands it straight to the guest store.
 */
/**
 * Compared with separators and case removed, so `guestToken`, `guest-token`
 * and `GUEST_TOKEN` are all caught. An exact-string match let a camelCase
 * spelling of the credential through untouched.
 */
const normalizeKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const STRIPPED_KEYS = new Set(["widgettype", "assistantinstructions", "guesttoken"]);

export function stripUiFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUiFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRIPPED_KEYS.has(normalizeKey(k))) continue;
      out[k] = stripUiFields(v);
    }
    return out;
  }
  return value;
}

/**
 * A guest token assignment written into free text — `"guest_token":"…"` in a
 * JSON blob, or `guest_token=…` in a log line. Key-based stripping cannot help
 * here: the credential is inside a string value, not under a key of its own.
 */
const GUEST_TOKEN_IN_TEXT = /("?guest[_-]?token"?\s*[:=]\s*"?)([^"\s,}]+)/gi;

/**
 * Remove guest tokens from a string. Redacts the assignment form above, plus
 * any exact values the caller already knows (the one just issued, and anything
 * on file for the cart) — a token echoed bare in a sentence is only removable
 * if we have seen it.
 */
export function redactGuestTokens(text: string, known: Iterable<string> = []): string {
  let out = text.replace(GUEST_TOKEN_IN_TEXT, (_m, lead: string) => `${lead}[redacted]`);
  for (const token of known) {
    if (token && token.length >= 8) out = out.split(token).join("[redacted]");
  }
  return out;
}

export class DdCliError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
    /** dd-cli >=0.2.6 `error.code`, when the failure carried one. */
    public readonly code?: DdErrorCode,
    /** Process exit status; 0.2.6 categorizes failures by it. */
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "DdCliError";
  }
}

/**
 * dd-cli >=0.2.6 error taxonomy. Before 0.2.6 every failure was exit 1 with
 * prose, so Peckish had to pattern-match the message text to tell an expired
 * sign-in from a rate limit. These codes replace the guessing — but the set
 * is open, so an unrecognized code is treated as `unknown`, per dd-cli.
 */
export type DdErrorCode =
  | "auth_expired"
  | "auth_forbidden"
  | "auth_missing"
  | "keychain_unavailable"
  | "gated"
  | "timeout"
  | "unreachable"
  | "rate_limited"
  | "server"
  | "bad_response"
  | "tool"
  | "unknown";

const AUTH_CODES = new Set(["auth_expired", "auth_forbidden", "auth_missing", "keychain_unavailable"]);
/** Exit 5: the call may be replayed — for reads. A timed-out write may have landed. */
const TRANSIENT_CODES = new Set(["timeout", "unreachable", "rate_limited"]);

/**
 * `{"error": {"code": "...", "message": "..."}}` — one line on stderr from
 * dd-cli >=0.2.6. Older releases print prose, so a miss here is normal.
 */
export function parseErrorLine(
  stderr: string,
): { code: DdErrorCode; message: string } | null {
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const e = (JSON.parse(t) as any)?.error;
      if (e && typeof e.code === "string") {
        return { code: e.code as DdErrorCode, message: String(e.message ?? "") };
      }
    } catch {
      // Not the error line — keep looking.
    }
  }
  return null;
}

function execDd(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      DD_CLI,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          // dd-cli can echo a guest token in a failure message, and `detail`
          // reaches the model and the audit log from several call sites — so
          // it is scrubbed here, at the one place all of them share.
          const detail = redactGuestTokens(`${stdout}\n${stderr}`.trim());
          // dd-cli >=0.2.6 states the category outright; older releases only
          // have prose, so the regex stays as the fallback for them.
          const structured = parseErrorLine(stderr);
          const exitCode = typeof err.code === "number" ? err.code : undefined;
          const code = structured?.code;

          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new DdCliError(`dd-cli binary not found (looked for: ${DD_CLI}). ${installHint()}`),
            );
          } else if (
            (code && AUTH_CODES.has(code)) ||
            (!code &&
              /missing credentials|sign in with dd-cli login|token has expired|failed to authenticate|try running dd-cli login|DD_CLI_ACCESS_TOKEN|invalid access token/i.test(
                detail,
              ))
          ) {
            // The fix differs per environment: browser login on a desktop,
            // an injected DD_CLI_ACCESS_TOKEN in a headless container.
            reject(
              new DdCliError(
                `DoorDash sign-in is missing or expired. ${signinHint()}`,
                detail,
                code,
                exitCode,
              ),
            );
          } else if (code === "gated") {
            // Exit 4 is a settled no: the account lacks this feature.
            // Retrying it only burns calls and misleads the user.
            reject(
              new DdCliError(
                "This DoorDash account is not enabled for that feature or action. Do not retry — tell the user it is unavailable on their account.",
                detail,
                code,
                exitCode,
              ),
            );
          } else if (err.killed) {
            reject(
              new DdCliError(`dd-cli timed out after ${TIMEOUT_MS / 1000}s`, detail, code, exitCode),
            );
          } else {
            reject(
              new DdCliError(
                structured?.message
                  ? `dd-cli failed (${code}): ${structured.message}`
                  : `dd-cli exited with an error`,
                detail || err.message,
                code,
                exitCode,
              ),
            );
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

/**
 * Commands that do not accept --intent. `doubledash` is dd-cli's own stated
 * exception (0.2.6); `auth` and `export-token` run before there is a session
 * to describe. Passing --intent to any of them is a usage error (exit 2).
 */
const NO_INTENT_COMMANDS = new Set(["login", "doubledash", "auth", "export-token"]);

function withIntent(args: string[]): string[] {
  if (args.length && NO_INTENT_COMMANDS.has(args[0])) return args;
  if (args.includes("--intent")) return args;
  return [...args, "--intent", formatIntent(currentIntent)];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors observed to be transient backend/CLI hiccups worth one retry. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof DdCliError)) return false;
  // dd-cli >=0.2.6 says so directly. Trust the code over the prose: exit 4
  // (gated) and exit 7 (rejected) must never be retried, and both used to
  // slip past the regex below on words like "try again".
  if (err.code) return TRANSIENT_CODES.has(err.code);
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
  return stripUiFields(await ddJsonRaw(args, opts)) as Record<string, unknown>;
}

/**
 * The payload as dd-cli sent it, stripping nothing.
 *
 * Only for the guest sub-cart add, which must read the one-time `guest_token`
 * out of the response before it is dropped. Everything else calls ddJson —
 * a raw payload must never be returned to the model.
 */
export async function ddJsonRaw(
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

/** First `guest_token` anywhere in a raw payload — dd-cli nests it on the sub-cart. */
export function findGuestToken(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    // Same normalization as the stripper, so a camelCase token is captured
    // rather than merely discarded — otherwise continuity is lost for nothing.
    if (normalizeKey(k) === "guesttoken" && typeof v === "string" && v) return v;
    const nested = findGuestToken(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * The response object out of whatever `--json-output` printed.
 *
 * dd-cli changed this shape in 0.2.6. Up to 0.2.5 every response was wrapped
 * in an MCP-shaped envelope and the real payload sat under
 * `structuredContent`. From 0.2.6 stdout IS the response object, already
 * parsed, with no envelope at all — so reading only `structuredContent`
 * turned every single command into "dd-cli returned an empty response". The
 * one exception 0.2.6 keeps is a response that is *only* plain text, which
 * still arrives as `{"content": [{"type": "text", "text": "..."}]}`.
 *
 * Returns null when there is no usable object, which the caller reports.
 */
export function unwrapPayload(envelope: unknown): Record<string, unknown> | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const env = envelope as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  };

  let payload: Record<string, unknown> | undefined;
  if (env.structuredContent) {
    payload = env.structuredContent;
  } else if (Array.isArray(env.content) && env.content.length && Object.keys(env).length === 1) {
    // `length === 1` matters: on 0.2.6 an ordinary payload that happens to
    // carry its own `content` key must not be mistaken for the text envelope.
    const text = env.content.find((c) => c?.type === "text")?.text;
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { message: text };
      }
    }
  } else {
    payload = env as Record<string, unknown>;
  }
  return payload && Object.keys(payload).length ? payload : null;
}

async function ddJsonOnce(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execDd(["--json-output", ...withIntent(args)]);
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new DdCliError("dd-cli returned non-JSON output", stdout.slice(0, 2000));
  }
  const payload = unwrapPayload(envelope);
  if (!payload) throw new DdCliError("dd-cli returned an empty response", stdout.slice(0, 2000));
  // Unstripped on purpose — ddJson strips on the way out, so the one caller
  // that needs the guest token can read it first.
  // `isError` is the <=0.2.5 envelope flag; 0.2.6 signals failure by exit
  // code and the stderr error line instead, handled in execDd.
  const { isError } = envelope as { isError?: boolean };
  return isError ? { ...payload, _cli_is_error: true } : payload;
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

/**
 * The default address is read on nearly every call now — search needs it for
 * location, menus and item details need it for promo eligibility — so it is
 * held for the life of the process and dropped whenever Peckish changes it.
 * Nothing else can change it mid-session except the DoorDash app, and a stale
 * read there costs one wrong promo context, not a wrong order: delivery
 * address comes from the cart, and preview_order restates it before submit.
 */
let defaultAddressCache: SavedAddress | null | undefined;

export async function getDefaultAddress(): Promise<SavedAddress | null> {
  if (defaultAddressCache !== undefined) return defaultAddressCache;
  const addresses = await listAddresses();
  defaultAddressCache = addresses.find((a) => a.is_default) ?? null;
  return defaultAddressCache;
}

/** Call after anything that changes which address is default. */
export function invalidateDefaultAddress(): void {
  defaultAddressCache = undefined;
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

// ---------------------------------------------------------------------------
// Version detection
//
// dd-cli gained flags in every release since 0.2.2 (--address-id in 0.2.4,
// the search filters in 0.2.5, `address find/add` in 0.2.3). Passing a flag an
// older binary doesn't know turns a useful request into a parse error, so
// Peckish asks the binary what it is, once per process, and gates the
// behaviours it applies *automatically* on a confirmed version.
//
// Flags the model asked for explicitly are always passed through: if the
// binary is too old, dd-cli's own error names the flag, which is a far better
// message than Peckish silently ignoring the request.
// ---------------------------------------------------------------------------

let versionProbe: Promise<string | null> | null = null;

/** The installed dd-cli version, or null when it can't be determined. */
export function ddCliVersion(): Promise<string | null> {
  versionProbe ??= execDd(["--version"])
    .then(({ stdout, stderr }) => parseVersion(`${stdout}\n${stderr}`))
    .catch(() => null);
  return versionProbe;
}

/** Only for tests: forget the cached probe. */
export function resetVersionCache(): void {
  versionProbe = null;
}

/**
 * True only when the installed dd-cli is known to be >= `min`. An unknown
 * version answers false — automatic upgrades stay off until we can prove the
 * binary supports them.
 */
export async function ddCliAtLeast(min: string): Promise<boolean> {
  const v = await ddCliVersion();
  return v != null && compareVersions(v, min) >= 0;
}
