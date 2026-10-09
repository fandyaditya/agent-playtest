/**
 * Integration harness: a real example game, a real Chromium, and the real CLI.
 *
 * Everything here drives the built CLI (`dist/cli.js`) as a consumer would, so
 * these tests cover the daemon lifecycle, the in-page bridge and the browser
 * driver at once. They are opt-in (`pnpm test:integration`) because they need a
 * Chromium that can render WebGL and a machine that is not on fire.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXAMPLE_ROOT = join(PACKAGE_ROOT, "examples", "spinner");
export const CLI = join(PACKAGE_ROOT, "dist", "cli.js");
export const EXAMPLE_PORT = Number(process.env.GAMEPROB_EXAMPLE_PORT ?? 5199);
export const EXAMPLE_URL = `http://127.0.0.1:${EXAMPLE_PORT}/?gameprob=1`;
export const HOME = join(PACKAGE_ROOT, ".tmp-integration-home");

export function chromiumPath(): string | undefined {
  const explicit = process.env.GAMEPROB_CHROMIUM_PATH;
  if (explicit) return explicit;
  for (const candidate of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function requireBuild(): void {
  if (!existsSync(CLI)) {
    throw new Error(`Build first: ${CLI} is missing (run "pnpm build").`);
  }
}

/** Environment for every CLI invocation: isolated machine home, real browser. */
export function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GAMEPROB_HOME: HOME,
    ...extra,
  };
  const chromium = chromiumPath();
  if (chromium) env.GAMEPROB_CHROMIUM_PATH = chromium;
  return env;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Parsed `--json` envelope, or null when the command printed no JSON. */
  json: Record<string, unknown> | null;
  durationMs: number;
}

export function runCli(
  args: string[],
  options: { project?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const project = options.project ?? EXAMPLE_ROOT;
  const argv = [CLI, "--project", project, ...args];
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: PACKAGE_ROOT,
      env: cliEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`gameprob ${args.join(" ")} timed out after ${options.timeoutMs ?? 120_000}ms`),
      );
    }, options.timeoutMs ?? 120_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: Record<string, unknown> | null = null;
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          json = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          json = null;
        }
      }
      resolvePromise({ code: code ?? -1, stdout, stderr, json, durationMs: Date.now() - started });
    });
  });
}

/** Envelope `data` for a successful command, failing loudly when it did not succeed. */
export function dataOf<T>(result: CliResult, command: string): T {
  if (!result.json) {
    throw new Error(`gameprob ${command} printed no JSON envelope. stderr: ${result.stderr}`);
  }
  if (result.json.ok !== true) {
    throw new Error(`gameprob ${command} failed: ${JSON.stringify(result.json.error)}`);
  }
  return result.json.data as T;
}

export function errorOf(result: CliResult): { code?: string; message?: string; hint?: string } {
  const error = result.json?.error;
  if (!error || typeof error !== "object") {
    throw new Error(`expected an error envelope, got: ${result.stdout}${result.stderr}`);
  }
  return error as { code?: string; message?: string; hint?: string };
}

export interface ExampleServer {
  url: string;
  stop: () => Promise<void>;
}

/** Are we already serving the bundled example on this port? */
async function reuseIfRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    if (!response.ok) return false;
    const body = await response.text();
    // Only reuse something that really is this example game.
    return body.includes('id="game"') || body.includes("gameprob");
  } catch {
    return false;
  }
}

/** Start the bundled example game and wait until it answers HTTP. */
export async function startExampleServer(port = EXAMPLE_PORT): Promise<ExampleServer> {
  // A developer (or an earlier run) may already serve this example. Reuse it:
  // killing an unrelated server would be both rude and flaky.
  if (await reuseIfRunning(port)) {
    return { url: `http://127.0.0.1:${port}/?gameprob=1`, stop: async () => undefined };
  }

  const child: ChildProcess = spawn(process.execPath, [join(EXAMPLE_ROOT, "server.mjs")], {
    cwd: EXAMPLE_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`example server did not start: ${output}`)),
      20_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("listening on")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async () => {
      clearTimeout(timer);
      // The port may have been taken between our probe and the bind: reuse
      // whoever won instead of failing the whole suite.
      if (await reuseIfRunning(port)) resolvePromise();
      else reject(new Error(`example server exited early: ${output}`));
    });
  });

  // The listening line is printed after `listen` resolves, but poll once anyway
  // so a test can never race the first request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    url: `http://127.0.0.1:${port}/?gameprob=1`,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((r) => child.once("close", () => r()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

export function resetHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
}
