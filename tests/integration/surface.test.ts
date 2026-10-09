/**
 * Integration surface checks that need the built CLI but no browser.
 *
 * These are the contract checks a consumer hits immediately: honest errors for
 * a project that was never initialized, a refused off-machine target, and a
 * version-matched guide from the installed package.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXAMPLE_ROOT, errorOf, requireBuild, resetHome, runCli } from "./harness.ts";

describe("CLI contract against a real project", () => {
  beforeAll(() => {
    requireBuild();
    resetHome();
  }, 60_000);

  afterAll(async () => {
    await runCli(["close"], { timeoutMs: 30_000 });
  });

  it("prints the guide for the installed version", async () => {
    const result = await runCli(["skills", "get", "core", "--json"], { timeoutMs: 30_000 });
    const data = result.json?.data as { content?: string; version?: string } | undefined;

    expect(result.code).toBe(0);
    expect(data?.content).toContain("gameprob snapshot");
    expect(data?.content).toContain("| `STALE_REF` | 4 |");
    expect(data?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("adds the reference when --full is passed", async () => {
    const result = await runCli(["skills", "get", "core", "--full", "--json"], {
      timeoutMs: 30_000,
    });
    const data = result.json?.data as { content?: string; full?: boolean } | undefined;
    expect(data?.full).toBe(true);
    expect(data?.content?.length).toBeGreaterThan(5_000);
  });

  it("refuses to guess a project that has no .gameprob workspace", async () => {
    const bare = mkdtempSync(join(tmpdir(), "gameprob-it-bare-"));
    try {
      const result = await runCli(["snapshot", "--json"], { project: bare, timeoutMs: 30_000 });
      expect(result.code).toBe(2);
      expect(errorOf(result).code).toBe("PROJECT_NOT_INITIALIZED");
      expect(errorOf(result).hint).toContain("gameprob init");
      expect(existsSync(join(bare, ".gameprob"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("refuses a non-loopback target unless the caller opts in", async () => {
    const result = await runCli(["open", "http://example.com/", "--json"], { timeoutMs: 60_000 });
    expect(result.code).toBe(6);
    expect(errorOf(result).code).toBe("UNAUTHORIZED_TARGET");
    expect(errorOf(result).hint).toContain("--allow-remote");
  });

  it("reports a missing session instead of starting a browser", async () => {
    const result = await runCli(["inspect", "@g1", "--json"], { timeoutMs: 60_000 });
    expect(result.code).toBe(3);
    expect(errorOf(result).code).toBe("SESSION_NOT_FOUND");
  });

  it("keeps warnings on stderr and data on stdout in human mode", async () => {
    const result = await runCli(["skills", "get", "core"], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("gameprob capture");
    expect(result.stdout.trim().startsWith("{")).toBe(false);
  });

  it("exposes the example project's committed workspace", () => {
    expect(existsSync(join(EXAMPLE_ROOT, ".gameprob", "config.json"))).toBe(true);
    expect(existsSync(join(EXAMPLE_ROOT, ".gameprob", "bridge.ts"))).toBe(true);
  });
});
