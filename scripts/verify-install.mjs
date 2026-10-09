#!/usr/bin/env node
/**
 * Install smoke test: pack, install into a throwaway project, run the binary
 * the way a consumer does — through the `node_modules/.bin` symlink.
 *
 * This is the check that catches packaging bugs that a repository checkout
 * hides: missing bundle chunks, unresolved templates, and shebang/realpath
 * problems in the bin entry. No browser, no network beyond the local tarball.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    problems.push(name);
  }
}

function npm(args, cwd) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (!existsSync(join(root, "dist", "cli.js"))) {
  console.error("dist/cli.js is missing — run `pnpm build` first.");
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), "gameprob-install-"));
const packDir = join(sandbox, "pack");
const consumer = join(sandbox, "consumer");
const game = join(sandbox, "game");

try {
  console.log(`install smoke — ${sandbox}`);

  // 1. Pack and install exactly what npm would ship.
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  mkdirSync(game, { recursive: true });
  const packed = npm(["pack", "--pack-destination", packDir], root).trim().split("\n").pop();
  const tarball = join(packDir, packed);
  check("npm pack", existsSync(tarball), packed);

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }, null, 2),
  );
  npm(["install", "--no-audit", "--no-fund", tarball], consumer);
  // npm exposes a package bin differently per platform: a shell script on
  // POSIX, a `.cmd` shim on Windows.
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gameprob.cmd" : "gameprob",
  );
  check("bin installed", existsSync(bin));

  // 2. Run the binary through the shim: this is where a broken realpath guard
  // ("npx gameprob does nothing") shows up.
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" });
  check("gameprob --version via bin", /^\d+\.\d+\.\d+/.test(version.trim()), version.trim());

  const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
  check(
    "gameprob --help lists every command",
    ["init", "open", "snapshot", "inspect", "act", "capture", "run", "close", "skills"].every(
      (command) => help.includes(command),
    ),
  );

  const skills = execFileSync(bin, ["skills", "get", "core", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const envelope = JSON.parse(skills);
  check("skills get core reads bundled data", (envelope.data?.content ?? "").includes("gameprob"));

  // 3. `init` must work from the installed package: templates resolve relative
  // to the installed root, not to the repository.
  writeFileSync(
    join(game, "package.json"),
    JSON.stringify({ name: "smoke-game", version: "1.0.0" }, null, 2),
  );
  const init = execFileSync(bin, ["init", "--json"], { cwd: game, encoding: "utf8" });
  const created = JSON.parse(init).data?.created ?? [];
  check(
    "init creates the workspace",
    existsSync(join(game, ".gameprob", "config.json")),
    `${created.length} files`,
  );
  for (const file of ["AGENTS.md", "config.json", "bridge.ts", "progress.md", "tests/.gitkeep"]) {
    check(`init created ${file}`, existsSync(join(game, ".gameprob", file)));
  }

  const config = JSON.parse(readFileSync(join(game, ".gameprob", "config.json"), "utf8"));
  check(
    "config is templated, not literal",
    config.project?.name === "smoke-game",
    `name=${config.project?.name}`,
  );

  // 4. A missing workspace must fail with the documented code, not a crash.
  const bare = join(sandbox, "bare");
  mkdirSync(bare, { recursive: true });
  let exitCode = 0;
  try {
    execFileSync(bin, ["snapshot", "--json"], {
      cwd: bare,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    exitCode = error.status;
  }
  check("snapshot without a workspace exits 2", exitCode === 2, `exit=${exitCode}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(
  problems.length === 0 ? "\ninstall smoke OK" : `\ninstall smoke FAILED (${problems.length})`,
);
process.exit(problems.length === 0 ? 0 : 1);
