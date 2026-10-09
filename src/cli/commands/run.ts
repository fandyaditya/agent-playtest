/**
 * `agent-playtest run` — execute project-authored Playwright Test specs.
 *
 * Deliberately a thin wrapper: Playwright Test owns workers, retries, reporters
 * and isolation. `run` only resolves the spec root, generates a private config
 * (never touching the user's `playwright.config.*`), spawns the runner, and
 * normalizes the JSON report into Agent Playtest's evidence layout.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { timestampId } from "../../browser/capture.ts";
import { AgentPlaytestError, toAgentPlaytestError } from "../../shared/errors.ts";
import { atomicWriteFile, atomicWriteJson, resolveInside } from "../../shared/paths.ts";
import { type CommandResult, loadContext } from "../context.ts";

export interface RunCommandOptions {
  project?: string;
  workers?: string;
}

export interface RunResultData {
  runId: string;
  runDir: string;
  expected: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  resultFile: string;
  failures: string[];
  exitCode: number;
}

const SPEC_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"]);
/**
 * Ceiling for the whole Playwright child process.
 *
 * The per-test timeout in the generated config is generous because software
 * rendering is slow; three such tests plus browser startup must still fit here.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export async function runTests(
  spec: string | undefined,
  options: RunCommandOptions,
): Promise<CommandResult<RunResultData>> {
  const context = loadContext({ project: options.project, requireWorkspace: true });
  const { projectRoot, config, paths } = context;

  const target = spec ? resolveInside(projectRoot, spec, "test spec") : paths.testsDir;
  if (!existsSync(target)) {
    throw new AgentPlaytestError({
      code: "TEST_SETUP_FAILED",
      message: `No test path exists at ${target}.`,
      hint: "Create .agent-playtest/tests/<name>.spec.ts (see `agent-playtest skills get core`).",
    });
  }

  const specs = collectSpecs(target);
  if (specs.length === 0) {
    throw new AgentPlaytestError({
      code: "TEST_SETUP_FAILED",
      message: `No *.spec.ts files were found under ${target}.`,
      hint: 'Write one with `import { test, expect } from "agent-playtest/test"` and run `agent-playtest run` again. Nothing was executed, so nothing passed.',
    });
  }

  const workers = resolveWorkers(options.workers);
  const runId = `run-${timestampId()}`;
  const runDir = join(paths.outputDir, runId);
  mkdirSync(runDir, { recursive: true });
  const reportFile = join(runDir, "playwright-report.json");
  const configFile = join(runDir, "playwright.config.mjs");
  const logFile = join(runDir, "logs", "playwright.log");
  const resultFile = join(runDir, "result.json");

  atomicWriteFile(
    configFile,
    playwrightConfig({ context: { projectRoot, config, paths }, runDir, reportFile, workers }),
  );

  const cli = playwrightCliPath();
  const started = Date.now();
  const outcome = await runPlaywright(cli, configFile, {
    cwd: projectRoot,
    // An explicit spec argument must narrow what Playwright executes, not just
    // what `run` reports on afterwards.
    files: spec ? specs.map((file) => relativeTo(projectRoot, file)) : [],
    env: {
      ...process.env,
      AGENT_PLAYTEST_PROJECT: projectRoot,
      AGENT_PLAYTEST_RUN_DIR: runDir,
      ...(config.game.url ? { AGENT_PLAYTEST_URL: config.game.url } : {}),
    },
    timeoutMs: RUN_TIMEOUT_MS,
  });

  atomicWriteFile(logFile, outcome.output);

  const report = readReport(reportFile);
  if (!report) {
    throw new AgentPlaytestError({
      code: "TEST_SETUP_FAILED",
      message: `Playwright Test did not produce a JSON report (exit code ${outcome.exitCode}).`,
      hint: `Read the log: ${relativeTo(projectRoot, logFile)}. A common cause is a missing browser: npx playwright install --only-shell chromium.`,
    });
  }

  const stats = report.stats ?? {};
  const expected = Number(stats.expected ?? 0);
  const unexpected = Number(stats.unexpected ?? 0);
  const flaky = Number(stats.flaky ?? 0);
  const skipped = Number(stats.skipped ?? 0);
  const total = expected + unexpected + flaky + skipped;
  const failures = collectFailures(report).slice(0, 20);

  const data: RunResultData = {
    runId,
    runDir: relativeTo(projectRoot, runDir),
    expected: total,
    passed: expected,
    failed: unexpected,
    skipped,
    flaky,
    resultFile: relativeTo(projectRoot, resultFile),
    failures,
    exitCode: outcome.exitCode,
  };

  atomicWriteJson(resultFile, {
    ...data,
    project: config.project.name,
    durationMs: Date.now() - started,
    specs: specs.map((file) => relativeTo(projectRoot, file)),
    browser: { backend: config.browser.backend, viewport: config.browser.viewport },
    log: relativeTo(projectRoot, logFile),
  });

  if (total === 0) {
    throw new AgentPlaytestError({
      code: "TEST_FAILED",
      message: `Playwright matched specs but ran no tests in ${target}.`,
      hint: `Add a test(...) declaration. Evidence: ${data.runDir}`,
    });
  }

  if (unexpected > 0) {
    throw new AgentPlaytestError({
      code: "TEST_FAILED",
      message: `${unexpected} of ${total} test(s) failed. First failure: ${failures[0] ?? "(no message captured)"}`,
      hint: `Evidence: ${data.runDir}`,
    });
  }

  if (outcome.exitCode !== 0) {
    throw new AgentPlaytestError({
      code: "TEST_FAILED",
      message: `Playwright exited with code ${outcome.exitCode} even though no test was reported as failed.`,
      hint: `Read the log: ${relativeTo(projectRoot, logFile)}`,
    });
  }

  return { data, warnings: flaky > 0 ? [`${flaky} test(s) only passed on retry.`] : [] };
}

interface PlaywrightContext {
  context: {
    projectRoot: string;
    config: ReturnType<typeof loadContext>["config"];
    paths: ReturnType<typeof loadContext>["paths"];
  };
  runDir: string;
  reportFile: string;
  workers: number;
}

function playwrightConfig(input: PlaywrightContext): string {
  const { config, paths } = input.context;
  const settings = {
    testDir: paths.testsDir,
    testMatch: ["**/*.spec.ts", "**/*.spec.mts", "**/*.spec.js"],
    fullyParallel: false,
    workers: input.workers,
    // Generous on purpose. A browser game has to boot WebGL before the first
    // assertion, and containers that fall back to software rendering can spend
    // tens of seconds on a single frame capture — more when the host is busy.
    // A tight timeout turns slow hardware into fake test failures.
    timeout: 180_000,
    expect: { timeout: 10_000 },
    forbidOnly: false,
    reporter: [["list"], ["json", { outputFile: input.reportFile }]],
    outputDir: join(input.runDir, "artifacts"),
    use: {
      headless: config.browser.headless,
      viewport: config.browser.viewport,
      deviceScaleFactor: config.browser.deviceScaleFactor,
      ...(config.browser.executablePath
        ? { launchOptions: { executablePath: config.browser.executablePath } }
        : {}),
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
    },
  };
  return [
    "// Generated by `agent-playtest run`. Do not edit: it is rewritten on every run and",
    "// your own playwright.config.* is never touched.",
    `export default ${JSON.stringify(settings, null, 2)};`,
    "",
  ].join("\n");
}

function resolveWorkers(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: `--workers must be an integer between 1 and 16 (received ${value}).`,
      hint: "The default of 1 keeps GPU timing predictable; raise it only after benchmarking.",
    });
  }
  return parsed;
}

function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  try {
    const packageJson = require.resolve("@playwright/test/package.json");
    return join(dirname(packageJson), "cli.js");
  } catch (error) {
    throw new AgentPlaytestError({
      code: "TEST_SETUP_FAILED",
      message: "Could not resolve @playwright/test, which `agent-playtest run` needs.",
      hint: "Reinstall agent-playtest so its dependencies are present.",
      cause: error,
    });
  }
}

interface SpawnOutcome {
  exitCode: number;
  output: string;
}

async function runPlaywright(
  cli: string,
  configFile: string,
  options: { cwd: string; files: string[]; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<SpawnOutcome> {
  return await new Promise<SpawnOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "test", "--config", configFile, ...options.files], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new AgentPlaytestError({
          code: "TEST_FAILED",
          message: `The Playwright run exceeded ${options.timeoutMs}ms and was terminated.`,
        }),
      );
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(toAgentPlaytestError(error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

interface PlaywrightReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
  suites?: unknown[];
  errors?: Array<{ message?: string }>;
}

function readReport(path: string): PlaywrightReport | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlaywrightReport;
  } catch {
    return null;
  }
}

function collectFailures(report: PlaywrightReport): string[] {
  const failures: string[] = [];
  const walk = (suite: unknown): void => {
    if (!suite || typeof suite !== "object") return;
    const node = suite as {
      title?: string;
      specs?: unknown[];
      suites?: unknown[];
      ok?: boolean;
    };
    for (const spec of node.specs ?? []) {
      const typed = spec as {
        title?: string;
        ok?: boolean;
        tests?: Array<{ results?: Array<{ status?: string; error?: { message?: string } }> }>;
      };
      if (typed.ok !== false) continue;
      const errorMessage = typed.tests
        ?.flatMap((test) => test.results ?? [])
        .find((result) => result.error?.message)?.error?.message;
      failures.push(
        `${typed.title ?? node.title ?? "test"}: ${(errorMessage ?? "failed").split("\n")[0]}`,
      );
    }
    for (const child of node.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  for (const error of report.errors ?? []) {
    if (error.message) failures.push(error.message.split("\n")[0] as string);
  }
  return failures;
}

function collectSpecs(target: string): string[] {
  const stats = statSync(target);
  if (stats.isFile()) return isSpec(target) ? [target] : [];
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (isSpec(full)) found.push(full);
    }
  };
  walk(target, 0);
  return found.sort();
}

function isSpec(file: string): boolean {
  return file.includes(".spec.") && SPEC_EXTENSIONS.has(extname(file));
}

function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}
