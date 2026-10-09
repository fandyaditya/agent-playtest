import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectEngine } from "../../src/cli/detect-engine.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-playtest-engine-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePackage(value: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(value));
}

function writeSource(relative: string, contents: string): void {
  const file = join(root, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
}

describe("engine detection from dependencies", () => {
  it("finds Three.js in dependencies", () => {
    writePackage({ dependencies: { three: "^0.186.0" } });
    const detection = detectEngine(root);
    expect(detection.hint).toBe("three");
    expect(detection.evidence).toEqual(['package.json declares "three"']);
  });

  it("finds React Three Fiber as a Three.js hint", () => {
    writePackage({ devDependencies: { "@react-three/fiber": "^9.0.0" } });
    expect(detectEngine(root).hint).toBe("three");
  });

  it("finds Phaser and Pixi", () => {
    writePackage({ dependencies: { phaser: "^3.80.0" } });
    expect(detectEngine(root).hint).toBe("phaser");

    writePackage({ dependencies: { "pixi.js": "^8.0.0" } });
    expect(detectEngine(root).hint).toBe("pixi");
  });

  it("refuses to guess when several engines are declared", () => {
    writePackage({ dependencies: { three: "^1", phaser: "^2" } });
    const detection = detectEngine(root);
    expect(detection.hint).toBe("unknown");
    expect(detection.evidence.join(" ")).toContain("intentionally left unknown");
  });
});

describe("engine detection from source", () => {
  it("falls back to imports when package.json says nothing", () => {
    writeSource("src/main.ts", 'import * as THREE from "three";\n');
    const detection = detectEngine(root);
    expect(detection.hint).toBe("three");
    expect(detection.evidence).toContain('source files import "three"');
  });

  it("recognizes require() as well as import", () => {
    writeSource("game.js", 'const Phaser = require("phaser");\n');
    expect(detectEngine(root).hint).toBe("phaser");
  });

  it("ignores generated and vendored directories", () => {
    writeSource("node_modules/three/index.js", 'import "three";\n');
    writeSource("dist/bundle.js", 'import "three";\n');
    writeSource(".agent-playtest/notes.js", 'import "phaser";\n');
    expect(detectEngine(root).hint).toBe("unknown");
  });

  it("stops scanning once two engines are visible", () => {
    writeSource("a.ts", 'import "three";\n');
    writeSource("b.ts", 'import "pixi.js";\n');
    expect(detectEngine(root).hint).toBe("unknown");
  });

  it("reports no hint at all for an empty project", () => {
    const detection = detectEngine(root);
    expect(detection.hint).toBe("unknown");
    expect(detection.evidence).toEqual([]);
  });
});
