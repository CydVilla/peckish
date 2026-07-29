/**
 * Sign-in assist: launch `dd-cli login` for the user and poll until the
 * keychain token works, instead of telling them to go run it themselves.
 *
 * `dd-cli login` opens the DoorDash sign-in flow in the user's browser and
 * exits once the token is stored — the same pattern the Mac app's onboarding
 * uses. One login child at a time; polling probes with a read-only command.
 */
import { spawn } from "node:child_process";
import { ddJson, DdCliError, resolveDdCliPath } from "./ddcli.js";

/** Matches the message ddcli.ts attaches to missing/expired-credential failures. */
export function isAuthError(err: unknown): boolean {
  return err instanceof DdCliError && /sign-in is missing or expired/i.test(err.message);
}

let loginChild: ReturnType<typeof spawn> | null = null;

export function loginInProgress(): boolean {
  return loginChild !== null;
}

/**
 * Spawn `dd-cli login` (no-op if one is already running). The child owns the
 * browser flow; we never read its output — success is observed by probing.
 */
export function launchLogin(): void {
  if (loginChild) return;
  const child = spawn(resolveDdCliPath(), ["login"], { stdio: "ignore" });
  loginChild = child;
  child.on("exit", () => {
    if (loginChild === child) loginChild = null;
  });
  child.on("error", () => {
    if (loginChild === child) loginChild = null;
  });
  child.unref();
}

/** One read-only auth check. True = signed in; false = auth still missing. */
export async function probeSignin(): Promise<boolean> {
  try {
    await ddJson(["address", "list"]);
    return true;
  } catch (err) {
    if (isAuthError(err)) return false;
    throw err;
  }
}

export interface WaitResult {
  signedIn: boolean;
  /** Set when polling stopped on a non-auth failure (e.g. binary vanished). */
  error?: string;
}

/**
 * Poll until sign-in works, the deadline passes, or a non-auth error appears.
 * `onTick` fires after each unsuccessful probe (progress dots, UI pings).
 */
export async function waitForSignin(opts: {
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: () => void;
}): Promise<WaitResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const interval = opts.intervalMs ?? 3_000;
  for (;;) {
    try {
      if (await probeSignin()) return { signedIn: true };
    } catch (err) {
      return { signedIn: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (Date.now() >= deadline) return { signedIn: false };
    opts.onTick?.();
    await new Promise((r) => setTimeout(r, interval));
  }
}
