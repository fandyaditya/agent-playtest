import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAct } from "../../src/cli/commands/act.ts";
import { runCapture } from "../../src/cli/commands/capture.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import { GameProbError } from "../../src/shared/errors.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gameprob-args-"));
  process.env.GAMEPROB_HOME = join(root, "home");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
  runInit({ project: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.GAMEPROB_HOME;
});

async function expectInvalid(run: () => Promise<unknown>): Promise<GameProbError> {
  const error = await expectFailure(run);
  expect(error.code).toBe("INVALID_ARGUMENT");
  expect(error.exitCode).toBe(2);
  return error;
}

async function expectFailure(run: () => Promise<unknown>): Promise<GameProbError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GameProbError);
    return error as GameProbError;
  }
  throw new Error("expected the command to fail");
}

describe("act argument validation", () => {
  it("names the supported actions when the action is missing or unknown", async () => {
    const missing = await expectInvalid(() => runAct(undefined, [], { project: root }));
    expect(missing.message).toContain("keydown, keyup, press, click, step");

    const unknown = await expectInvalid(() => runAct("state", [], { project: root }));
    expect(unknown.message).toContain('"state"');
  });

  it("requires exactly one key for the keyboard actions", async () => {
    const none = await expectInvalid(() => runAct("keydown", [], { project: root }));
    expect(none.message).toContain("exactly one key");
    await expectInvalid(() => runAct("press", ["A", "B"], { project: root }));
    await expectInvalid(() => runAct("keyup", [], { project: root }));
  });

  it("requires two numeric coordinates for click", async () => {
    await expectInvalid(() => runAct("click", ["400"], { project: root }));
    const nan = await expectInvalid(() => runAct("click", ["x", "y"], { project: root }));
    expect(nan.message).toContain("numeric coordinates");
  });

  it("requires a positive whole tick count for step", async () => {
    await expectInvalid(() => runAct("step", [], { project: root }));
    await expectInvalid(() => runAct("step", ["0"], { project: root }));
    const fractional = await expectInvalid(() => runAct("step", ["1.5"], { project: root }));
    expect(fractional.message).toContain("positive whole number");
    await expectInvalid(() => runAct("step", ["lots"], { project: root }));
  });

  it("explains that the project must be initialized before it looks for a session", async () => {
    const bare = mkdtempSync(join(tmpdir(), "gameprob-bare-"));
    try {
      const error = await expectFailure(() => runAct("step", ["10"], { project: bare }));
      expect(error.code).toBe("PROJECT_NOT_INITIALIZED");
      expect(error.hint).toContain("gameprob init");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("capture argument validation", () => {
  it("insists on either --page or a subject", async () => {
    const error = await expectInvalid(() => runCapture(undefined, { project: root }));
    expect(error.message).toContain("--page");
    expect(error.hint).toContain("gameprob capture --page");
  });

  it("rejects an unknown view and lists the supported ones", async () => {
    const error = await expectInvalid(() =>
      runCapture("@g2", { project: root, views: "front,sideways" }),
    );
    expect(error.message).toContain('"sideways"');
    expect(error.hint).toContain("front, back, left, right, top, bottom, current");
  });

  it("stops at the missing workspace once the arguments are valid", async () => {
    const bare = mkdtempSync(join(tmpdir(), "gameprob-bare-capture-"));
    try {
      const error = await expectFailure(() => runCapture(undefined, { project: bare, page: true }));

      // Argument parsing succeeded, so the failure is the absent workspace.
      expect(error.code).toBe("PROJECT_NOT_INITIALIZED");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
