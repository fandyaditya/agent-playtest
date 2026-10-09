import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteJson,
  isInside,
  machineHome,
  packageVersion,
  projectKey,
  projectPaths,
  readSessionMeta,
  resolveInside,
  resolveProjectRoot,
  sessionEndpoint,
  writeSessionMeta,
} from "../../src/shared/paths.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "agent-playtest-paths-"));
  process.env.AGENT_PLAYTEST_HOME = join(scratch, "home");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.AGENT_PLAYTEST_HOME;
});

describe("machine home", () => {
  it("honours AGENT_PLAYTEST_HOME so tests never touch the real home directory", () => {
    expect(machineHome()).toBe(resolve(join(scratch, "home")));
  });
});

describe("projectPaths", () => {
  it("keeps every generated artifact inside .agent-playtest/", () => {
    const paths = projectPaths("/game");
    expect(paths.workspace).toBe("/game/.agent-playtest");
    expect(paths.configFile).toBe("/game/.agent-playtest/config.json");
    expect(paths.bridgeFile).toBe("/game/.agent-playtest/bridge.ts");
    expect(paths.testsDir).toBe("/game/.agent-playtest/tests");
    expect(paths.bugsDir).toBe("/game/.agent-playtest/bugs");
    expect(paths.outputDir).toBe("/game/.agent-playtest/output");
  });
});

describe("resolveInside", () => {
  it("accepts a path inside the root", () => {
    const root = join(scratch, "game");
    mkdirSync(root, { recursive: true });
    expect(resolveInside(root, ".agent-playtest/config.json")).toBe(
      join(root, ".agent-playtest/config.json"),
    );
  });

  it("rejects .. traversal", () => {
    const root = join(scratch, "game");
    mkdirSync(root, { recursive: true });
    expect(() => resolveInside(root, "../escape.txt")).toThrowError(/outside the project/);
  });

  it("rejects a symlink that escapes the root", () => {
    const root = join(scratch, "game");
    const outside = join(scratch, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "link"));

    expect(() => resolveInside(root, "link/file.txt")).toThrowError(/symlink out of the project/);
  });

  it("isInside treats the root itself as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/c")).toBe(false);
  });
});

describe("resolveProjectRoot", () => {
  it("rejects a missing directory with INVALID_ARGUMENT", () => {
    expect(() => resolveProjectRoot(join(scratch, "nope"))).toThrowError(/does not exist/);
  });

  it("canonicalizes an existing directory", () => {
    const root = join(scratch, "game");
    mkdirSync(root, { recursive: true });
    expect(resolveProjectRoot(root)).toBe(resolve(root));
  });
});

describe("session endpoint", () => {
  it("keys the session by project so two projects never share a daemon", () => {
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    expect(projectKey(a)).not.toBe(projectKey(b));
    expect(sessionEndpoint(a).key).toBe(projectKey(a));
  });

  it("falls back to the temp directory when the socket path would be too long", () => {
    const longRoot = join(scratch, "x".repeat(200));
    mkdirSync(longRoot, { recursive: true });
    const endpoint = sessionEndpoint(longRoot);

    expect(Buffer.byteLength(endpoint.socketPath)).toBeLessThanOrEqual(100);
    expect(endpoint.socketPath.startsWith(tmpdir())).toBe(true);
    // The meta file is not a socket, so it stays under the machine home.
    expect(endpoint.metaPath.startsWith(join(scratch, "home"))).toBe(true);
  });

  it("round-trips session metadata and rejects incomplete files", () => {
    const root = join(scratch, "game");
    mkdirSync(root, { recursive: true });
    const endpoint = sessionEndpoint(root);

    writeSessionMeta(endpoint, {
      schemaVersion: 1,
      protocolVersion: 1,
      sessionId: "s_1",
      pid: process.pid,
      socketPath: endpoint.socketPath,
      projectRoot: root,
      token: "t",
      startedAt: new Date(0).toISOString(),
    });

    expect(readSessionMeta(endpoint)?.sessionId).toBe("s_1");

    writeFileSync(endpoint.metaPath, JSON.stringify({ sessionId: "s_2" }));
    expect(readSessionMeta(endpoint)).toBeNull();
  });
});

describe("package metadata", () => {
  it("reports the version this CLI was built from", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("writes JSON atomically with a trailing newline", () => {
    const file = join(scratch, "out", "value.json");
    atomicWriteJson(file, { a: 1 });
    expect(readSessionMeta({ metaPath: file, key: "k", socketPath: "", logPath: "" })).toBeNull();
  });
});
