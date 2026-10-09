/**
 * Chromium launch and page lifecycle.
 *
 * `chromium-shell` is Playwright's default headless shell; `chromium` selects
 * the full browser (new headless mode), which renders WebGL differently. The
 * chosen backend is always reported so baselines are not silently compared
 * across renderers.
 */

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { AgentPlaytestError } from "../shared/errors.ts";

export type BrowserBackend = "chromium-shell" | "chromium";

export interface LaunchOptions {
  headless: boolean;
  backend: BrowserBackend;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  /**
   * Explicit Chromium binary. Needed on musl-based systems (for example Alpine),
   * where Playwright's glibc builds cannot start, and in other containers that
   * ship their own browser.
   */
  executablePath?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  backendLabel: string;
  close(): Promise<void>;
}

export function backendLabel(
  backend: BrowserBackend,
  headless: boolean,
  executablePath?: string,
): string {
  const mode = headless ? "headless" : "headed";
  const base = backend === "chromium" ? `Chromium (full, ${mode})` : "Chromium headless shell";
  return executablePath ? `${base} @ ${executablePath}` : base;
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: options.headless,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(!options.executablePath && options.backend === "chromium" ? { channel: "chromium" } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingBrowser =
      /Executable doesn't exist|please run the following command|browserType\.launch/i.test(
        message,
      );
    throw new AgentPlaytestError({
      code: "BROWSER_LAUNCH_FAILED",
      message: `Could not launch Chromium: ${message.split("\n")[0]}`,
      hint: missingBrowser
        ? "Install the browser once with: npx playwright install --only-shell chromium, or point browser.executablePath / AGENT_PLAYTEST_CHROMIUM_PATH at a Chromium build this machine can run."
        : "Check that the browser backend in .agent-playtest/config.json is available on this machine.",
      cause: error,
    });
  }

  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor,
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    backendLabel: backendLabel(options.backend, options.headless, options.executablePath),
    async close(): Promise<void> {
      try {
        await context.close();
      } catch {
        // ignore
      }
      try {
        await browser.close();
      } catch {
        // ignore
      }
    },
  };
}
