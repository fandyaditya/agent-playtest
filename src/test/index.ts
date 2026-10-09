/**
 * `gameprob/test` — the Playwright Test fixture for project-authored game tests.
 *
 * Tests import `{ test, expect }` from here and receive a `game` fixture that
 * drives the game through the SAME driver the CLI uses, so a check written by
 * hand in the terminal behaves identically when it is saved as a test.
 *
 * Runs inside Playwright Test: isolated browser context, no daemon, no LLM.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { type ActRequest, BrowserGameDriver, type ConsoleEntry } from "../browser/driver.ts";
import { loadProjectConfig } from "../shared/config.ts";
import { GameProbError } from "../shared/errors.ts";
import { projectPaths, resolveProjectRoot } from "../shared/paths.ts";
import type { ResolvedConfig } from "../shared/schemas.ts";
import type {
  ActionResult,
  CaptureResult,
  CaptureViewName,
  GameCapabilities,
  InspectOptions,
  InspectResult,
  OpenResult,
  SnapshotOptions,
  SnapshotResult,
} from "../shared/types.ts";

export interface GameCaptureOptions {
  /** Persistent selector (preferred) or a session-local `@gN` ref. */
  selector?: string;
  /** Capture the whole page instead of one object. */
  page?: boolean;
  views?: CaptureViewName[];
  /** Base name for the generated files; defaults to the subject slug. */
  name?: string;
  /** Explicit project-relative path, passed through to `capture --out`. */
  out?: string;
  overwrite?: boolean;
}

export class GameSession {
  readonly page: Page;
  readonly driver: BrowserGameDriver;
  readonly projectRoot: string;
  readonly config: ResolvedConfig;
  /** Absolute directory holding this run's evidence. */
  readonly runDir: string;

  readonly #testInfo: TestInfo;

  private constructor(options: {
    driver: BrowserGameDriver;
    projectRoot: string;
    config: ResolvedConfig;
    runDir: string;
    testInfo: TestInfo;
  }) {
    this.driver = options.driver;
    this.page = options.driver.page;
    this.projectRoot = options.projectRoot;
    this.config = options.config;
    this.runDir = options.runDir;
    this.#testInfo = options.testInfo;
  }

  static async create(page: Page, testInfo: TestInfo): Promise<GameSession> {
    const projectRoot = resolveProjectRoot(process.env.GAMEPROB_PROJECT ?? process.cwd());
    const paths = projectPaths(projectRoot);
    if (!existsSync(paths.configFile)) {
      throw new GameProbError({
        code: "PROJECT_NOT_INITIALIZED",
        message: `No GameProb workspace found at ${paths.workspace}.`,
        hint: "Run `gameprob init` before running project tests.",
      });
    }
    const config = loadProjectConfig(projectRoot);
    const runDir = process.env.GAMEPROB_RUN_DIR ?? paths.outputDir;
    const driver = new BrowserGameDriver({
      projectRoot,
      config,
      page,
      outputRoot: join(runDir, "screenshots"),
    });
    const session = new GameSession({ driver, projectRoot, config, runDir, testInfo });

    const url = process.env.GAMEPROB_URL ?? config.game.url;
    if (url && process.env.GAMEPROB_NO_AUTO_OPEN !== "1") {
      await session.open(url);
    }
    return session;
  }

  async open(url?: string, options: { allowRemote?: boolean } = {}): Promise<OpenResult> {
    const result = await this.driver.open(url, options);
    for (const warning of result.warnings) this.#annotate(warning);
    return result;
  }

  capabilities(): Promise<GameCapabilities> {
    return this.driver.capabilities();
  }

  snapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    return this.driver.snapshot(options);
  }

  inspect(selector: string, options: InspectOptions = {}): Promise<InspectResult> {
    return this.driver.inspect(selector, options);
  }

  act(request: ActRequest): Promise<ActionResult> {
    return this.driver.act(request);
  }

  keydown(key: string): Promise<ActionResult> {
    return this.driver.act({ action: "keydown", key });
  }

  keyup(key: string): Promise<ActionResult> {
    return this.driver.act({ action: "keyup", key });
  }

  press(key: string): Promise<ActionResult> {
    return this.driver.act({ action: "press", key });
  }

  click(x: number, y: number): Promise<ActionResult> {
    return this.driver.act({ action: "click", x, y });
  }

  /** Advance a fixed timestep. Requires the project's simulation hooks. */
  step(ticks: number, dtSeconds?: number): Promise<{ ticks: number; warnings: string[] }> {
    return this.driver.step(ticks, dtSeconds);
  }

  /** Load a deterministic fixture. Requires the project's simulation hooks. */
  reset(fixture?: string): Promise<void> {
    return this.driver.reset(fixture);
  }

  /** Read gameplay state from the game itself, not from the DOM. */
  state(subject?: string): Promise<unknown> {
    return this.driver.state(subject);
  }

  action(name: string, args: unknown = {}): Promise<void> {
    return this.driver.action(name, args);
  }

  inspectBody(subject: string): Promise<unknown> {
    return this.driver.inspectBody(subject);
  }

  contacts(subject: string): Promise<unknown> {
    return this.driver.contacts(subject);
  }

  /**
   * Capture evidence and attach it to the Playwright report so a failing run
   * carries the screenshots that explain it.
   */
  async capture(options: GameCaptureOptions = {}): Promise<CaptureResult> {
    const single = !(options.views && options.views.length > 1);
    const base = options.name ?? (options.page ? "page" : "capture");
    const generated = join(
      relative(this.projectRoot, this.driver.outputRoot),
      single ? `${base}.png` : base,
    );
    const result = await this.driver.capture({
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.page ? { page: true } : {}),
      ...(options.views ? { views: options.views } : {}),
      out: options.out ?? generated,
      ...(options.overwrite ? { overwrite: true } : {}),
    });
    for (const view of result.views) {
      await this.#testInfo.attach(`${base}-${view.view}`, {
        path: isAbsolute(view.path) ? view.path : join(this.projectRoot, view.path),
        contentType: "image/png",
      });
    }
    return result;
  }

  consoleEntries(): ConsoleEntry[] {
    return this.driver.consoleEntries();
  }

  /** Browser console errors and uncaught page errors seen during this test. */
  consoleErrors(): ConsoleEntry[] {
    return this.driver.consoleErrors();
  }

  async dispose(): Promise<void> {
    const entries = this.driver.consoleEntries();
    if (entries.length > 0) {
      const file = join(this.runDir, "logs", "browser-console.jsonl");
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(
          file,
          `${entries
            .map((entry) => JSON.stringify({ ...entry, test: this.#testInfo.title }))
            .join("\n")}\n`,
        );
      } catch {
        // Evidence logging must never fail an otherwise valid test.
      }
    }
    this.driver.dispose();
  }

  #annotate(message: string): void {
    this.#testInfo.annotations.push({ type: "gameprob", description: message });
  }
}

export interface GameFixtures {
  game: GameSession;
}

export const test = base.extend<GameFixtures>({
  game: async ({ page }, use, testInfo) => {
    const session = await GameSession.create(page, testInfo);
    try {
      await use(session);
    } finally {
      await session.dispose();
    }
  },
});

export { GameProbError } from "../shared/errors.ts";
export type {
  ActionResult,
  CaptureResult,
  CaptureViewName,
  GameCapabilities,
  InspectResult,
  OpenResult,
  SnapshotResult,
} from "../shared/types.ts";
export type { Page, TestInfo };
export { expect };
