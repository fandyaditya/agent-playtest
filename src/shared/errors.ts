/**
 * Stable, versioned error codes and their process exit classes.
 *
 * These codes are a public contract (see TECH_DOCS.md §4.11): agents branch on
 * them, so never renumber or repurpose one.
 */

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "CONFIG_INVALID"
  | "PROJECT_NOT_INITIALIZED"
  | "SESSION_NOT_FOUND"
  | "BROWSER_LAUNCH_FAILED"
  | "NAVIGATION_FAILED"
  | "BRIDGE_NOT_CONNECTED"
  | "CAPABILITY_UNAVAILABLE"
  | "OBJECT_NOT_FOUND"
  | "STALE_REF"
  | "TEST_FAILED"
  | "TEST_SETUP_FAILED"
  | "UNAUTHORIZED_TARGET"
  | "IPC_PROTOCOL_MISMATCH"
  | "INTERNAL_ERROR";

export const EXIT_CODES: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 2,
  CONFIG_INVALID: 2,
  PROJECT_NOT_INITIALIZED: 2,
  SESSION_NOT_FOUND: 3,
  BROWSER_LAUNCH_FAILED: 3,
  NAVIGATION_FAILED: 3,
  BRIDGE_NOT_CONNECTED: 4,
  CAPABILITY_UNAVAILABLE: 4,
  OBJECT_NOT_FOUND: 4,
  STALE_REF: 4,
  TEST_FAILED: 5,
  TEST_SETUP_FAILED: 5,
  UNAUTHORIZED_TARGET: 6,
  IPC_PROTOCOL_MISMATCH: 7,
  INTERNAL_ERROR: 1,
};

export interface GameProbErrorOptions {
  code: ErrorCode;
  message: string;
  /** Capability keys or hook names that would make the operation possible. */
  missing?: string[];
  hint?: string;
  cause?: unknown;
}

export class GameProbError extends Error {
  readonly code: ErrorCode;
  readonly missing?: string[];
  readonly hint?: string;

  constructor(options: GameProbErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GameProbError";
    this.code = options.code;
    if (options.missing) this.missing = options.missing;
    if (options.hint) this.hint = options.hint;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toEnvelope(): { code: string; message: string; missing?: string[]; hint?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.missing ? { missing: this.missing } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export function toGameProbError(error: unknown): GameProbError {
  if (error instanceof GameProbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GameProbError({ code: "INTERNAL_ERROR", message, cause: error });
}

export function capabilityError(message: string, missing: string[], hint?: string): GameProbError {
  return new GameProbError({ code: "CAPABILITY_UNAVAILABLE", message, missing, hint });
}
