/**
 * One interactive browser session per project.
 *
 * Owns the Chromium process and the shared `BrowserGameDriver`, keeps them alive
 * across independent CLI invocations, and tears everything down on idle timeout,
 * explicit `close`, or process shutdown.
 */

import {
  type ActRequest,
  assertAllowedTarget,
  BrowserGameDriver,
  outputRootFor,
} from "../browser/driver.ts";
import { type BrowserSession, launchBrowser } from "../browser/playwright.ts";
import { AgentPlaytestError } from "../shared/errors.ts";
import type { ResolvedConfig } from "../shared/schemas.ts";
import type {
  ActionResult,
  CaptureOptions,
  CaptureResult,
  InspectOptions,
  InspectResult,
  OpenResult,
  SnapshotOptions,
  SnapshotResult,
} from "../shared/types.ts";

export interface SessionContext {
  projectRoot: string;
  config: ResolvedConfig;
  sessionId: string;
  idleTimeoutMs: number;
  onIdle(): void;
  log(message: string): void;
}

export class ProjectSession {
  #context: SessionContext;
  #browser: BrowserSession | null = null;
  #driver: BrowserGameDriver | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(context: SessionContext) {
    this.#context = context;
  }

  get sessionId(): string {
    return this.#context.sessionId;
  }

  get browserLabel(): string | null {
    return this.#browser?.backendLabel ?? null;
  }

  get isOpen(): boolean {
    return this.#browser !== null;
  }

  /** Resets the idle countdown; called after every completed command. */
  touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#closed) return;
    const timeout = this.#context.idleTimeoutMs;
    this.#idleTimer = setTimeout(() => {
      this.#context.log(`Idle for ${timeout}ms; closing the browser session.`);
      void this.close().then(() => this.#context.onIdle());
    }, timeout);
    this.#idleTimer.unref?.();
  }

  async open(params: {
    url?: string;
    allowRemote?: boolean;
    headed?: boolean;
  }): Promise<OpenResult> {
    const warnings: string[] = [];
    if (params.headed === true) {
      if (this.#browser) {
        warnings.push(
          `--headed was ignored: the browser for this project is already running (headless=${this.#context.config.browser.headless}). Run \`agent-playtest close\` and open again to change it.`,
        );
      } else {
        this.#context.config.browser.headless = false;
      }
    }
    // Validate the target BEFORE launching a browser: a refused origin must not
    // cost a Chromium start, and must never reach the network.
    const raw = params.url ?? this.#context.config.game.url;
    if (!raw) {
      throw new AgentPlaytestError({
        code: "INVALID_ARGUMENT",
        message: "No URL was provided and .agent-playtest/config.json has no game.url.",
        hint: "Run: agent-playtest open http://127.0.0.1:5173/?agent-playtest=1",
      });
    }
    const target = assertAllowedTarget(raw, params.allowRemote === true);

    const driver = await this.#ensureDriver();
    const result = await driver.open(target, { allowRemote: params.allowRemote });
    return { ...result, warnings: [...warnings, ...result.warnings] };
  }

  async snapshot(params: SnapshotOptions): Promise<SnapshotResult> {
    return this.#requireDriver().snapshot(params);
  }

  async inspect(params: { selector: string } & InspectOptions): Promise<InspectResult> {
    const { selector, ...options } = params;
    return this.#requireDriver().inspect(selector, options);
  }

  async act(params: ActRequest): Promise<ActionResult> {
    return this.#requireDriver().act(params);
  }

  async capture(params: CaptureOptions): Promise<CaptureResult> {
    return this.#requireDriver().capture(params);
  }

  async close(): Promise<void> {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const browser = this.#browser;
    const driver = this.#driver;
    this.#browser = null;
    this.#driver = null;
    driver?.dispose();
    if (browser) {
      this.#context.log("Closing browser session.");
      await browser.close();
    }
  }

  /** Marks the session permanently closed (daemon shutdown). */
  shutdown(): void {
    this.#closed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async #ensureDriver(): Promise<BrowserGameDriver> {
    if (this.#driver) return this.#driver;
    const config = this.#context.config;
    this.#context.log(
      `Launching ${config.browser.backend} (headless=${config.browser.headless}) for ${this.#context.projectRoot}`,
    );
    const browser = await launchBrowser({
      headless: config.browser.headless,
      backend: config.browser.backend,
      viewport: config.browser.viewport,
      deviceScaleFactor: config.browser.deviceScaleFactor,
      ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
    });
    this.#browser = browser;
    this.#driver = new BrowserGameDriver({
      projectRoot: this.#context.projectRoot,
      config,
      page: browser.page,
      outputRoot: outputRootFor(this.#context.projectRoot, config),
      browserLabel: browser.backendLabel,
    });
    return this.#driver;
  }

  #requireDriver(): BrowserGameDriver {
    if (!this.#driver) {
      throw new AgentPlaytestError({
        code: "SESSION_NOT_FOUND",
        message: "No browser session is open for this project.",
        hint: "Run `agent-playtest open <url>` first.",
      });
    }
    return this.#driver;
  }
}
