import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-playtest-init-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("agent-playtest init", () => {
  it("creates the workspace, the tests/bugs directories and nothing else", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
    const result = runInit({ project: root });

    expect(result.created).toEqual([
      ".agent-playtest/AGENTS.md",
      ".agent-playtest/config.json",
      ".agent-playtest/bridge.ts",
      ".agent-playtest/progress.md",
      ".agent-playtest/.gitignore",
      ".agent-playtest/tests/.gitkeep",
      ".agent-playtest/bugs/.gitkeep",
    ]);
    expect(result.preserved).toEqual([]);
    expect(existsSync(join(root, ".agent-playtest/tests"))).toBe(true);
    expect(existsSync(join(root, ".agent-playtest/bugs"))).toBe(true);
  });

  it("fills the config template from project evidence", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@studio/spinner", dependencies: { three: "^1" } }),
    );
    const result = runInit({ project: root });

    const config = JSON.parse(read(".agent-playtest/config.json")) as {
      project: { name: string; engineHint: string };
      game: { url: string };
    };
    expect(result.engineHint).toBe("three");
    expect(config.project).toEqual({ name: "spinner", engineHint: "three" });
    expect(config.game.url).toContain("?agent-playtest=1");
    expect(read(".agent-playtest/config.json")).not.toContain("{{");
  });

  it("writes the Three.js bridge by default and the Phaser bridge for a Phaser project", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { three: "^1" } }));
    runInit({ project: root });
    expect(read(".agent-playtest/bridge.ts")).toContain("agent-playtest/bridge");

    const phaserRoot = mkdtempSync(join(tmpdir(), "agent-playtest-init-phaser-"));
    try {
      writeFileSync(
        join(phaserRoot, "package.json"),
        JSON.stringify({ dependencies: { phaser: "^3" } }),
      );
      runInit({ project: phaserRoot });
      const bridge = readFileSync(join(phaserRoot, ".agent-playtest/bridge.ts"), "utf8");
      expect(bridge.toLowerCase()).toContain("phaser");
    } finally {
      rmSync(phaserRoot, { recursive: true, force: true });
    }
  });

  it("is idempotent and never overwrites an existing file", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
    runInit({ project: root });

    writeFileSync(join(root, ".agent-playtest/bridge.ts"), "// my own bridge\n");
    const second = runInit({ project: root });

    expect(second.created).toEqual([]);
    expect(second.preserved).toHaveLength(5);
    expect(second.templateVersionMismatch).toEqual([]);
    expect(read(".agent-playtest/bridge.ts")).toBe("// my own bridge\n");
  });

  it("reports a template version mismatch instead of applying it", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
    mkdirSync(join(root, ".agent-playtest"), { recursive: true });
    writeFileSync(
      join(root, ".agent-playtest/AGENTS.md"),
      "# Old guide\n<!-- agent-playtest-template-version: 0 -->\n",
    );

    const result = runInit({ project: root });

    expect(result.templateVersionMismatch).toHaveLength(1);
    expect(result.templateVersionMismatch[0]).toContain("template version 0");
    expect(result.templateVersionMismatch[0]).toContain("never overwrites");
    expect(read(".agent-playtest/AGENTS.md")).toContain("# Old guide");
  });

  it("says when no engine could be detected", () => {
    const result = runInit({ project: root });
    expect(result.engineHint).toBe("unknown");
    expect(result.next.join(" ")).toContain("No engine was detected");
  });

  it("links the project root AGENTS.md once", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
    writeFileSync(join(root, "AGENTS.md"), "# Spinner\n");

    const first = runInit({ project: root, linkAgents: true });
    expect(first.agentsLinked).toBe(true);
    expect(read("AGENTS.md")).toContain(".agent-playtest/AGENTS.md");
    expect(read("AGENTS.md").startsWith("# Spinner")).toBe(true);

    const second = runInit({ project: root, linkAgents: true });
    expect(second.agentsLinked).toBe(false);
    expect(read("AGENTS.md").match(/\.agent-playtest\/AGENTS\.md/g)).toHaveLength(1);
    expect(second.next.join(" ")).toContain("already referenced");
  });

  it("creates the root AGENTS.md when the project has none", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "spinner" }));
    runInit({ project: root, linkAgents: true });
    expect(read("AGENTS.md")).toContain("## Game testing");
  });

  it("rejects a project path that does not exist", () => {
    expect(() => runInit({ project: join(root, "missing") })).toThrowError(/does not exist/);
  });
});
