/**
 * Engine detection from project evidence.
 *
 * Findings are HINTS, never verified live capabilities: a dependency in
 * package.json says nothing about what the running page actually exposes. The
 * only trustworthy capability report comes from a connected bridge.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export type EngineHintName = "three" | "phaser" | "pixi" | "unknown";

export interface EngineDetection {
  hint: EngineHintName;
  evidence: string[];
}

const DEPENDENCY_ENGINES: Array<{ name: EngineHintName; packages: string[] }> = [
  { name: "three", packages: ["three", "@react-three/fiber", "@react-three/drei"] },
  { name: "phaser", packages: ["phaser"] },
  { name: "pixi", packages: ["pixi.js", "@pixi/core"] },
];

const IMPORT_PATTERNS: Array<{ name: EngineHintName; pattern: RegExp }> = [
  { name: "three", pattern: /from\s+["']three["']|require\(["']three["']\)/ },
  { name: "phaser", pattern: /from\s+["']phaser["']|require\(["']phaser["']\)/ },
  { name: "pixi", pattern: /from\s+["']pixi\.js["']|require\(["']pixi\.js["']\)/ },
];

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".agent-playtest",
  ".next",
  ".svelte-kit",
]);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;

export function detectEngine(projectRoot: string): EngineDetection {
  const evidence: string[] = [];
  const found = new Set<EngineHintName>();

  const packageFile = join(projectRoot, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(packageFile, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ]);
    for (const engine of DEPENDENCY_ENGINES) {
      for (const pkg of engine.packages) {
        if (declared.has(pkg)) {
          found.add(engine.name);
          evidence.push(`package.json declares "${pkg}"`);
        }
      }
    }
  } catch {
    // A missing or malformed package.json is not fatal: init works without it.
  }

  if (found.size === 0) {
    scanSources(projectRoot, found, evidence);
  }

  if (found.size === 0) return { hint: "unknown", evidence };
  if (found.size > 1) {
    return {
      hint: "unknown",
      evidence: [
        ...evidence,
        "Multiple engine packages were detected; the hint is intentionally left unknown.",
      ],
    };
  }
  return { hint: [...found][0] as EngineHintName, evidence };
}

function scanSources(projectRoot: string, found: Set<EngineHintName>, evidence: string[]): void {
  let files = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > 6 || files >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
      }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCAN_EXTENSIONS.has(extname(entry.name))) continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size === 0 || size > MAX_FILE_BYTES) continue;
      files += 1;
      let contents = "";
      try {
        contents = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const candidate of IMPORT_PATTERNS) {
        if (candidate.pattern.test(contents)) found.add(candidate.name);
      }
      if (found.size > 1) return;
    }
  };

  walk(projectRoot, 0);
  for (const name of found) {
    evidence.push(`source files import "${name}"`);
  }
}
