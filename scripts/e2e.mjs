#!/usr/bin/env node
/**
 * End-to-end smoke test: one real browser, one real daemon, the bundled example
 * game, driven entirely through the published CLI surface.
 *
 * This is the maintainer's "does the whole thing work" script. It needs a
 * Chromium that can render WebGL; on Alpine that means `chromium` plus
 * `chromium-swiftshader`, pointed at with AGENT_PLAYTEST_CHROMIUM_PATH.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples", "spinner");
const cli = join(root, "dist", "cli.js");
const home = join(root, ".tmp-e2e-home");
const port = Number(process.env.AGENT_PLAYTEST_EXAMPLE_PORT ?? 5199);
const url = `http://127.0.0.1:${port}/?agent-playtest=1`;

const steps = [];
let failures = 0;

function step(name, detail = "") {
  steps.push(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
}

function bad(name, detail) {
  failures += 1;
  steps.push(`  FAIL ${name} — ${detail}`);
}

function chromium() {
  if (process.env.AGENT_PLAYTEST_CHROMIUM_PATH) return process.env.AGENT_PLAYTEST_CHROMIUM_PATH;
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function env() {
  const value = { ...process.env, AGENT_PLAYTEST_HOME: home };
  const browser = chromium();
  if (browser) value.AGENT_PLAYTEST_CHROMIUM_PATH = browser;
  return value;
}

function runCli(args, timeoutMs = 180_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, "--project", example, ...args], {
      cwd: root,
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = stdout.trim().startsWith("{") ? JSON.parse(stdout.trim()) : null;
      } catch {
        json = null;
      }
      resolvePromise({ code, stdout, stderr, json });
    });
  });
}

/** Is this port already serving the bundled example game? */
async function reuseIfRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (!response.ok) return false;
    const body = await response.text();
    return body.includes('id="game"') || body.includes("agent-playtest");
  } catch {
    return false;
  }
}

async function startServer() {
  // A developer may already be serving this example; reuse it rather than
  // fighting over the port.
  if (await reuseIfRunning()) {
    step("server", `reusing http://127.0.0.1:${port}`);
    return { kill: () => undefined };
  }

  const child = spawn(process.execPath, [join(example, "server.mjs")], {
    cwd: example,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 20_000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("listening on")) {
        clearTimeout(timer);
        resolvePromise();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async () => {
      clearTimeout(timer);
      // The port was taken between the probe and the bind: whoever won is fine.
      if (await reuseIfRunning()) resolvePromise();
      else reject(new Error(`server exited: ${output}`));
    });
  });
  return child;
}

async function main() {
  if (!existsSync(cli)) {
    console.error("dist/cli.js is missing — run `pnpm build` first.");
    process.exit(1);
  }
  if (!chromium()) {
    console.error("No Chromium found. Set AGENT_PLAYTEST_CHROMIUM_PATH (see docs/DECISIONS.md).");
    process.exit(1);
  }

  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await runCli(["close"], 30_000);

  const server = await startServer();
  try {
    const open = await runCli(["open", url, "--json"], 120_000);
    if (open.code !== 0)
      bad("open", open.stderr.trim() || open.json?.error?.message || open.stdout);
    else {
      const data = open.json.data;
      if (data.bridge?.connected !== true) bad("open", "no bridge was detected");
      else step("open", `${data.browser}, bridge ${data.bridge.engine}`);
    }

    const snapshot = await runCli(["snapshot", "--json"], 120_000);
    if (snapshot.code !== 0)
      bad("snapshot", snapshot.stderr.trim() || snapshot.json?.error?.message || snapshot.stdout);
    else {
      const objects = snapshot.json.data.objects ?? [];
      const hero = objects.find((object) => object.selector === "agent-playtest:id=main-hero");
      if (!hero) bad("snapshot", "main-hero was not discoverable");
      else step("snapshot", `${objects.length} objects, hero ${hero.ref}`);
    }

    const before = await runCli(["inspect", "agent-playtest:id=main-hero", "--json"], 120_000);
    if (before.code !== 0)
      bad("inspect", before.stderr.trim() || before.json?.error?.message || before.stdout);
    else step("inspect", `x=${before.json.data.worldPosition?.[0]}`);

    await runCli(["act", "keydown", "ArrowRight", "--json"]);
    await runCli(["act", "step", "240", "--json"]);
    await runCli(["act", "keyup", "ArrowRight", "--json"]);

    const after = await runCli(["inspect", "agent-playtest:id=main-hero", "--json"], 120_000);
    const x = after.json?.data?.worldPosition?.[0];
    if (after.code !== 0)
      bad("act", after.stderr.trim() || after.json?.error?.message || after.stdout);
    else if (!(x > 1.4 && x <= 1.5201))
      bad("act", `hero stopped at x=${x}, expected the 1.52 clamp`);
    else step("act", `hero clamped at x=${x}`);

    const page = await runCli(
      [
        "capture",
        "--page",
        "--out",
        ".agent-playtest/output/e2e-page.png",
        "--overwrite",
        "--json",
      ],
      180_000,
    );
    if (page.code !== 0 || page.json.data?.views?.[0]?.nonBlank !== true) {
      bad(
        "capture --page",
        page.stderr.trim() || page.json?.error?.message || "blank or missing frame",
      );
    } else {
      const view = page.json.data.views[0];
      step("capture --page", `${view.width}x${view.height}, ${view.bytes} bytes`);
    }

    const object = await runCli(
      [
        "capture",
        "agent-playtest:id=main-hero",
        "--views",
        "front,right",
        "--out",
        ".agent-playtest/output/e2e-hero",
        "--overwrite",
        "--json",
      ],
      240_000,
    );
    if (object.code !== 0 || (object.json.data?.views ?? []).length !== 2) {
      bad(
        "capture object",
        object.stderr.trim() || object.json?.error?.message || "expected two views",
      );
    } else if (object.json.data.views.some((view) => view.nonBlank !== true)) {
      bad("capture object", "a view came back blank");
    } else {
      step(
        "capture object",
        object.json.data.views.map((view) => `${view.width}x${view.height}`).join(", "),
      );
    }

    const run = await runCli(["run", "--json"], 900_000);
    const summary = run.json?.data;
    if (run.code !== 0 || summary?.failed !== 0) {
      bad(
        "run",
        run.stderr.trim() ||
          run.json?.error?.message ||
          `passed ${summary?.passed} of ${summary?.expected}`,
      );
    } else {
      step("run", `${summary.passed}/${summary.expected} example specs passed`);
    }

    const closed = await runCli(["close", "--json"], 60_000);
    if (closed.code !== 0)
      bad("close", closed.stderr.trim() || closed.json?.error?.message || closed.stdout);
    else step("close", "session stopped");
  } finally {
    await runCli(["close"], 60_000);
    server.kill("SIGTERM");
  }

  console.log("agent-playtest end-to-end");
  for (const line of steps) console.log(line);
  console.log(failures === 0 ? "\nE2E OK" : `\nE2E FAILED (${failures} step(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
