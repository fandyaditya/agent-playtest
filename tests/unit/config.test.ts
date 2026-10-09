import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferProjectName, loadProjectConfig } from "../../src/shared/config.ts";
import { DEFAULT_CONFIG, parseConfigFile, resolveConfig } from "../../src/shared/schemas.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "agent-playtest-config-"));
  process.env.AGENT_PLAYTEST_HOME = join(scratch, "home");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.AGENT_PLAYTEST_HOME;
  delete process.env.AGENT_PLAYTEST_CHROMIUM_PATH;
});

function writeProjectConfig(projectRoot: string, value: unknown): void {
  mkdirSync(join(projectRoot, ".agent-playtest"), { recursive: true });
  writeFileSync(join(projectRoot, ".agent-playtest", "config.json"), JSON.stringify(value));
}

function writeUserConfig(value: unknown): void {
  mkdirSync(process.env.AGENT_PLAYTEST_HOME as string, { recursive: true });
  writeFileSync(
    join(process.env.AGENT_PLAYTEST_HOME as string, "config.json"),
    JSON.stringify(value),
  );
}

describe("config precedence", () => {
  it("applies defaults when nothing is configured", () => {
    const config = resolveConfig({ projectName: "spinner" });
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      project: { name: "spinner", engineHint: "unknown" },
    });
  });

  it("ranks flags above project, project above user, user above defaults", () => {
    const config = resolveConfig({
      projectName: "spinner",
      user: { game: { url: "http://127.0.0.1:1/" }, session: { idleTimeoutMs: 5_000 } },
      project: { game: { url: "http://127.0.0.1:2/" }, session: { idleTimeoutMs: 10_000 } },
      flags: { url: "http://127.0.0.1:3/", idleTimeoutMs: 20_000 },
    });

    expect(config.game.url).toBe("http://127.0.0.1:3/");
    expect(config.session.idleTimeoutMs).toBe(20_000);
  });

  it("keeps user values that the project file does not mention", () => {
    const config = resolveConfig({
      projectName: "spinner",
      user: { browser: { viewport: { width: 1280, height: 720 } } },
      project: { browser: { headless: false } },
    });

    expect(config.browser.headless).toBe(false);
    expect(config.browser.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("lets an explicit flag turn headless back on", () => {
    const config = resolveConfig({
      projectName: "spinner",
      project: { browser: { headless: false } },
      flags: { headless: true },
    });
    expect(config.browser.headless).toBe(true);
  });
});

describe("config validation", () => {
  it("rejects unknown keys instead of silently ignoring them", () => {
    const parsed = parseConfigFile({ game: { url: "x", typo: 1 } }, "config.json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.message).toContain("config.json is not a valid Agent Playtest config");
  });

  it("rejects out-of-range viewports and idle timeouts", () => {
    expect(parseConfigFile({ browser: { viewport: { width: 10 } } }, "c").ok).toBe(false);
    expect(parseConfigFile({ session: { idleTimeoutMs: 100 } }, "c").ok).toBe(false);
    expect(parseConfigFile({ browser: { deviceScaleFactor: 9 } }, "c").ok).toBe(false);
  });

  it("refuses an unsupported schemaVersion rather than guessing", () => {
    const parsed = parseConfigFile({ schemaVersion: 99 }, "config.json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("schemaVersion 99");
      expect(parsed.message).toContain("No automatic migration");
    }
  });
});

describe("loadProjectConfig", () => {
  it("reads the project file, then the user file", () => {
    const projectRoot = join(scratch, "game");
    mkdirSync(projectRoot, { recursive: true });
    writeUserConfig({ browser: { backend: "chromium" } });
    writeProjectConfig(projectRoot, { game: { url: "http://127.0.0.1:5199/?agent-playtest=1" } });

    const config = loadProjectConfig(projectRoot);

    expect(config.game.url).toBe("http://127.0.0.1:5199/?agent-playtest=1");
    expect(config.browser.backend).toBe("chromium");
    expect(config.project.name).toBe("game");
  });

  it("treats AGENT_PLAYTEST_CHROMIUM_PATH as an explicit browser override", () => {
    const projectRoot = join(scratch, "game");
    mkdirSync(projectRoot, { recursive: true });
    writeProjectConfig(projectRoot, { browser: { executablePath: "/usr/bin/other" } });
    process.env.AGENT_PLAYTEST_CHROMIUM_PATH = "/usr/bin/chromium";

    expect(loadProjectConfig(projectRoot).browser.executablePath).toBe("/usr/bin/chromium");
  });

  it("takes the executable path from the project when the environment is silent", () => {
    const projectRoot = join(scratch, "game");
    mkdirSync(projectRoot, { recursive: true });
    writeProjectConfig(projectRoot, { browser: { executablePath: "/usr/bin/chromium" } });

    expect(loadProjectConfig(projectRoot).browser.executablePath).toBe("/usr/bin/chromium");
  });

  it("reports malformed JSON as CONFIG_INVALID", () => {
    const projectRoot = join(scratch, "game");
    mkdirSync(join(projectRoot, ".agent-playtest"), { recursive: true });
    writeFileSync(join(projectRoot, ".agent-playtest", "config.json"), "{ not json");

    expect(() => loadProjectConfig(projectRoot)).toThrowError(/not valid JSON/);
  });
});

describe("inferProjectName", () => {
  it("prefers package.json, stripping any scope", () => {
    const projectRoot = join(scratch, "dir-name");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "@studio/spinner" }));
    expect(inferProjectName(projectRoot)).toBe("spinner");
  });

  it("falls back to the directory name when there is no package.json", () => {
    const projectRoot = join(scratch, "my-game");
    mkdirSync(projectRoot, { recursive: true });
    expect(inferProjectName(projectRoot)).toBe("my-game");
  });
});
