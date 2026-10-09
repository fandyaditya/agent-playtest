import { afterEach, describe, expect, it, vi } from "vitest";
import { Output } from "../../src/cli/output.ts";
import { AgentPlaytestError } from "../../src/shared/errors.ts";
import { PROTOCOL_VERSION, type SnapshotResult } from "../../src/shared/types.ts";

function capture(run: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    run();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JSON envelope", () => {
  it("is one parseable object with the protocol version and command", () => {
    const output = new Output({ json: true });
    const { stdout, stderr } = capture(() => {
      output.success("close", { closed: true, sessionId: "s_1" }, ["a warning"]);
    });

    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("close");
    expect(envelope.data).toEqual({ closed: true, sessionId: "s_1" });
    expect(envelope.warnings).toEqual(["a warning"]);
    // Warnings belong to the envelope in JSON mode, not to stderr.
    expect(stderr).toBe("");
  });

  it("reports failures as an envelope and returns the exit code", () => {
    const output = new Output({ json: true });
    const error = new AgentPlaytestError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "no bridge",
      missing: ["scene.snapshot"],
      hint: "connect it",
    });
    let exitCode = 0;
    const { stdout } = capture(() => {
      exitCode = output.failure("snapshot", error);
    });

    const envelope = JSON.parse(stdout) as { ok: boolean; error: Record<string, unknown> };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(envelope.error.missing).toEqual(["scene.snapshot"]);
    expect(exitCode).toBe(4);
  });
});

describe("human output", () => {
  it("writes data to stdout and warnings to stderr", () => {
    const output = new Output({ json: false });
    const { stdout, stderr } = capture(() => {
      output.success("open", {
        url: "http://127.0.0.1:5173/",
        browser: "Chromium headless shell",
        bridge: { connected: true, engine: "three" },
        readiness: { domReady: true, gameReady: true },
        capabilities: { features: { "scene.snapshot": true, "input.pointer": false } },
      });
      output.success("snapshot", snapshotData(), ["careful"]);
    });

    expect(stdout).toContain("Opened: http://127.0.0.1:5173/");
    expect(stdout).toContain("Bridge: connected (three)");
    expect(stdout).toContain("Capabilities: scene.snapshot");
    expect(stdout).toContain("Scene: arena | Engine: three | Revision: 2");
    expect(stdout).toContain('@g1 scene "arena"');
    expect(stdout).toContain("Objects shown: 2 (of 3); depth: 4; truncated: true");
    expect(stderr).toContain("warning: careful");
  });

  it("says browser-only mode honestly instead of inventing a scene", () => {
    const output = new Output({ json: false });
    const { stdout } = capture(() => {
      output.success("open", {
        url: "http://127.0.0.1:5173/",
        browser: "Chromium headless shell",
        bridge: { connected: false },
        readiness: { domReady: true, gameReady: "unknown" },
        capabilities: { features: { "capture.page": true } },
      });
    });

    expect(stdout).toContain("Bridge: not detected (browser-only mode)");
    expect(stdout).toContain("Game ready: unknown");
    expect(stdout).toContain("Tip: run agent-playtest init");
  });

  it("renders failures with code, missing and hint on stderr", () => {
    const output = new Output({ json: false });
    let exitCode = 0;
    const { stdout, stderr } = capture(() => {
      exitCode = output.failure(
        "inspect",
        new AgentPlaytestError({
          code: "OBJECT_NOT_FOUND",
          message: 'No object has agent-playtest.id "nope".',
          hint: "Run snapshot first.",
        }),
      );
    });

    expect(stdout).toBe("");
    expect(stderr).toContain('error [OBJECT_NOT_FOUND]: No object has agent-playtest.id "nope".');
    expect(stderr).toContain("hint: Run snapshot first.");
    expect(exitCode).toBe(4);
  });

  it("renders run results without pretending a failed run passed", () => {
    const output = new Output({ json: false });
    const { stdout } = capture(() => {
      output.success("run", {
        runId: "run-1",
        runDir: ".agent-playtest/output/run-1",
        expected: 3,
        passed: 2,
        failed: 1,
        skipped: 0,
        flaky: 0,
        resultFile: ".agent-playtest/output/run-1/result.json",
      });
    });

    expect(stdout).toContain("Run run-1: 2/3 passed, 1 failed");
    expect(stdout).toContain("Evidence: .agent-playtest/output/run-1");
  });

  it("reports a closed session without a phantom session id", () => {
    const output = new Output({ json: false });
    const { stdout } = capture(() => {
      output.success("close", { closed: false, alreadyClosed: true });
    });
    expect(stdout.trim()).toBe(
      "No active Agent Playtest session for this project (already closed).",
    );
  });

  it("prints init notes for a template version mismatch", () => {
    const output = new Output({ json: false });
    const { stdout } = capture(() => {
      output.success("init", {
        projectRoot: "/game",
        workspace: "/game/.agent-playtest",
        created: [".agent-playtest/AGENTS.md"],
        preserved: [".agent-playtest/bridge.ts"],
        engineHint: "three",
        engineEvidence: ['package.json declares "three"'],
        templateVersionMismatch: [".agent-playtest/bridge.ts was created from template version 1."],
        next: ["Next: ask your coding agent to read .agent-playtest/AGENTS.md."],
      });
    });

    expect(stdout).toContain("Agent Playtest initialized: /game/.agent-playtest");
    expect(stdout).toContain("Preserved (already existed): .agent-playtest/bridge.ts");
    expect(stdout).toContain(
      "Note: .agent-playtest/bridge.ts was created from template version 1.",
    );
  });
});

function snapshotData(): SnapshotResult {
  return {
    meta: {
      mode: "full",
      engine: "three",
      sceneName: "arena",
      revision: 2,
      depth: 4,
      objectLimit: 200,
      objectsShown: 2,
      objectsTotal: 3,
      truncated: true,
    },
    objects: [
      {
        ref: "@g1",
        name: "arena",
        kind: "scene",
        engineType: "Scene",
        position: [0, 0, 0],
        childCount: 2,
      },
      {
        ref: "@g2",
        name: "Hero",
        kind: "mesh",
        engineType: "Mesh",
        selector: "agent-playtest:id=main-hero",
        visible: false,
      },
    ],
    warnings: [{ check: "snapshot.limited", message: "showing 2 of 3" }],
  };
}
