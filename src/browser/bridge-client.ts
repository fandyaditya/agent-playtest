/**
 * Node-side dispatcher for the in-page bridge.
 *
 * Every call is one `page.evaluate()` round trip with a JSON-serializable
 * result. Typed errors are rehydrated so the CLI can report stable codes.
 */

import type { Page } from "playwright";
import { type ErrorCode, GameProbError } from "../shared/errors.ts";
import { BRIDGE_GLOBAL, type EngineName } from "../shared/types.ts";

const ERROR_CODES = new Set<string>([
  "INVALID_ARGUMENT",
  "CONFIG_INVALID",
  "PROJECT_NOT_INITIALIZED",
  "SESSION_NOT_FOUND",
  "BROWSER_LAUNCH_FAILED",
  "NAVIGATION_FAILED",
  "BRIDGE_NOT_CONNECTED",
  "CAPABILITY_UNAVAILABLE",
  "OBJECT_NOT_FOUND",
  "STALE_REF",
  "TEST_FAILED",
  "TEST_SETUP_FAILED",
  "UNAUTHORIZED_TARGET",
  "IPC_PROTOCOL_MISMATCH",
  "INTERNAL_ERROR",
]);

export interface BridgeProbe {
  version: number;
  engine: EngineName;
}

/** Returns bridge metadata when a bridge is registered on the page, else null. */
export async function probeBridge(page: Page): Promise<BridgeProbe | null> {
  try {
    return await page.evaluate((globalName: string) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const bridge = scope[globalName] as { version?: unknown; engine?: unknown } | undefined;
      if (!bridge || typeof bridge !== "object") return null;
      return {
        version: typeof bridge.version === "number" ? bridge.version : 0,
        engine: (typeof bridge.engine === "string" ? bridge.engine : "custom") as never,
      };
    }, BRIDGE_GLOBAL);
  } catch {
    return null;
  }
}

export async function waitForBridge(page: Page, timeoutMs: number): Promise<BridgeProbe | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeBridge(page);
    if (probe) return probe;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(100);
  }
}

interface InPageFailure {
  code: string;
  message: string;
  missing?: string[];
  hint?: string;
}

/**
 * Calls `bridge.<dottedMethod>(...args)` inside the page.
 * Dotted paths (`simulation.step`) keep the bridge surface flat over IPC.
 */
export async function invokeBridge<T>(page: Page, method: string, args: unknown[]): Promise<T> {
  const outcome = await page.evaluate(
    (payload: { globalName: string; method: string; args: unknown[] }) => {
      const describe = (error: unknown) => {
        if (error && typeof error === "object") {
          const typed = error as {
            code?: unknown;
            message?: unknown;
            missing?: unknown;
            hint?: unknown;
          };
          return {
            code: typeof typed.code === "string" ? typed.code : "INTERNAL_ERROR",
            message: typeof typed.message === "string" ? typed.message : String(error),
            ...(Array.isArray(typed.missing) ? { missing: typed.missing as string[] } : {}),
            ...(typeof typed.hint === "string" ? { hint: typed.hint } : {}),
          };
        }
        return { code: "INTERNAL_ERROR", message: String(error) };
      };

      const scope = globalThis as unknown as Record<string, unknown>;
      const bridge = scope[payload.globalName] as Record<string, unknown> | undefined;
      if (!bridge) {
        return {
          ok: false as const,
          error: {
            code: "BRIDGE_NOT_CONNECTED",
            message: "No GameProb bridge is registered on this page.",
            hint: "Run `gameprob init`, connect .gameprob/bridge.ts in development, then reload with ?gameprob=1.",
          },
        };
      }

      const segments = payload.method.split(".");
      let holder: unknown = bridge;
      for (const segment of segments.slice(0, -1)) {
        holder = (holder as Record<string, unknown> | null | undefined)?.[segment];
      }
      const owner = holder as Record<string, unknown> | null | undefined;
      const fn = owner?.[segments[segments.length - 1] as string];
      if (typeof fn !== "function") {
        return {
          ok: false as const,
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: `The connected bridge does not expose "${payload.method}".`,
            missing: [payload.method],
          },
        };
      }

      try {
        const value = (fn as (...rest: unknown[]) => unknown).apply(owner, payload.args);
        return Promise.resolve(value).then(
          (resolved) => ({ ok: true as const, value: resolved === undefined ? null : resolved }),
          (error) => ({ ok: false as const, error: describe(error) }),
        );
      } catch (error) {
        return { ok: false as const, error: describe(error) };
      }
    },
    { globalName: BRIDGE_GLOBAL, method, args },
  );

  if (outcome.ok) return outcome.value as T;
  const failure = outcome.error as InPageFailure;
  const code = (ERROR_CODES.has(failure.code) ? failure.code : "INTERNAL_ERROR") as ErrorCode;
  throw new GameProbError({
    code,
    message: failure.message,
    ...(failure.missing ? { missing: failure.missing } : {}),
    ...(failure.hint ? { hint: failure.hint } : {}),
  });
}
