#!/usr/bin/env node
/**
 * Package smoke test: what `npm publish` would actually ship.
 *
 * Fails loudly when the tarball is missing something a consumer needs — the
 * CLI, the browser bridge, the test fixture, type declarations, templates,
 * skill data — or when source-only files leak into it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function fail(message) {
  problems.push(message);
}

if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("dist/cli.js is missing — run `pnpm build` first.");
  process.exit(1);
}

// 1. The tarball contents.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const [report] = JSON.parse(raw);
const files = report.files.map((entry) => entry.path);
const has = (path) => files.includes(path);

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/cli.js",
  "dist/bridge.js",
  "dist/bridge.d.ts",
  "dist/test.js",
  "dist/test.d.ts",
  "dist/daemon/entry.js",
  "templates/project/AGENTS.md",
  "templates/project/config.json",
  "templates/project/bridge.three.ts",
  "templates/project/bridge.phaser.ts",
  "templates/project/progress.md",
  "templates/project/gitignore",
  "skill-data/core.md",
  "skill-data/reference.md",
  "skills/agent-playtest/SKILL.md",
];
for (const path of required) {
  if (!has(path)) fail(`tarball is missing ${path}`);
}

const forbidden = files.filter(
  (path) =>
    path.startsWith("src/") ||
    path.startsWith("tests/") ||
    path.startsWith("examples/") ||
    path.startsWith("scripts/") ||
    path.startsWith("docs/") ||
    path.endsWith(".map") ||
    path.includes("node_modules/"),
);
for (const path of forbidden) fail(`tarball leaks ${path}`);

// 2. The published entry points exist, are ESM, and are declared.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cli = readFileSync(join(root, "dist", "cli.js"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node")) fail("dist/cli.js lost its shebang");
if (!(statSync(join(root, "dist", "cli.js")).mode & 0o111)) fail("dist/cli.js is not executable");
if (pkg.name !== "agent-playtest") fail("package.json name is not agent-playtest");
if (pkg.bin?.["agent-playtest"] !== "./dist/cli.js")
  fail("package.json bin does not point at dist/cli.js");
if (pkg.type !== "module") fail("package.json is not an ESM package");

for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  if (subpath === "./package.json") continue;
  for (const [condition, target] of Object.entries(entry)) {
    if (!target.startsWith("./")) fail(`export ${subpath} (${condition}) is not a relative path`);
    if (!existsSync(join(root, target)))
      fail(`export ${subpath} (${condition}) -> ${target} missing`);
  }
}

// 3. The bundle must not reference source-only paths, and must still find its
// bundled static assets (templates, skill data) next to the package root.
for (const bundle of ["dist/cli.js", "dist/bridge.js", "dist/test.js"]) {
  const source = readFileSync(join(root, bundle), "utf8");
  if (/from\s+["'][^"']*\/src\//.test(source)) fail(`${bundle} imports from src/`);
}
const cliBundle = readFileSync(join(root, "dist", "cli.js"), "utf8");
for (const asset of ["templates", "skill-data"]) {
  if (!cliBundle.includes(`"${asset}"`)) fail(`dist/cli.js no longer resolves ${asset}/`);
}

// 4. Templates must be self-describing, versioned and unsubstituted.
const marker = readFileSync(join(root, "templates", "project", "AGENTS.md"), "utf8");
if (!/agent-playtest-template-version:\s*\d+/.test(marker)) {
  fail("templates/project/AGENTS.md has no agent-playtest-template-version marker");
}
const configTemplate = readFileSync(join(root, "templates", "project", "config.json"), "utf8");
for (const placeholder of ["{{PROJECT_NAME}}", "{{ENGINE_HINT}}", "{{GAME_URL}}"]) {
  if (!configTemplate.includes(placeholder)) fail(`config.json template lost ${placeholder}`);
}
for (const template of ["progress.md", "bridge.three.ts", "bridge.phaser.ts"]) {
  const body = readFileSync(join(root, "templates", "project", template), "utf8");
  if (!/agent-playtest-template-version:\s*\d+/.test(body)) {
    fail(`templates/project/${template} has no agent-playtest-template-version marker`);
  }
}

// 5. Report.
const size = (report.unpackedSize / 1024).toFixed(0);
if (problems.length > 0) {
  console.error(`verify:package FAILED (${problems.length} problem(s))`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `verify:package OK — ${files.length} files, ${size} KiB unpacked (tarball ${(report.size / 1024).toFixed(0)} KiB)`,
);
