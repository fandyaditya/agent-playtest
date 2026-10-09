import { describe, expect, it } from "vitest";
import {
  capabilityError,
  type ErrorCode,
  EXIT_CODES,
  GameProbError,
  toGameProbError,
} from "../../src/shared/errors.ts";

const CASES: Array<[ErrorCode, number]> = [
  ["INVALID_ARGUMENT", 2],
  ["CONFIG_INVALID", 2],
  ["PROJECT_NOT_INITIALIZED", 2],
  ["SESSION_NOT_FOUND", 3],
  ["BROWSER_LAUNCH_FAILED", 3],
  ["NAVIGATION_FAILED", 3],
  ["BRIDGE_NOT_CONNECTED", 4],
  ["CAPABILITY_UNAVAILABLE", 4],
  ["OBJECT_NOT_FOUND", 4],
  ["STALE_REF", 4],
  ["TEST_FAILED", 5],
  ["TEST_SETUP_FAILED", 5],
  ["UNAUTHORIZED_TARGET", 6],
  ["IPC_PROTOCOL_MISMATCH", 7],
  ["INTERNAL_ERROR", 1],
];

describe("error codes and exit classes", () => {
  it.each(CASES)("%s exits with %i", (code, exit) => {
    const error = new GameProbError({ code, message: "nope" });
    expect(error.exitCode).toBe(exit);
    expect(EXIT_CODES[code]).toBe(exit);
  });

  it("keeps missing/hint out of the envelope when absent", () => {
    const error = new GameProbError({ code: "INTERNAL_ERROR", message: "boom" });
    expect(error.toEnvelope()).toEqual({ code: "INTERNAL_ERROR", message: "boom" });
  });

  it("carries capability detail into the envelope", () => {
    const error = capabilityError("no bridge", ["scene.snapshot"], "connect it");
    expect(error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(error.toEnvelope()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      message: "no bridge",
      missing: ["scene.snapshot"],
      hint: "connect it",
    });
  });

  it("wraps unknown failures as INTERNAL_ERROR without losing the message", () => {
    const wrapped = toGameProbError(new Error("kaput"));
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(wrapped.message).toBe("kaput");
    expect(toGameProbError("just a string").message).toBe("just a string");
  });

  it("returns GameProbErrors unchanged", () => {
    const original = new GameProbError({ code: "STALE_REF", message: "stale" });
    expect(toGameProbError(original)).toBe(original);
  });
});
