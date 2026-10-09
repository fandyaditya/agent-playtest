/**
 * Real browser input: Playwright keyboard and pointer events, never synthetic
 * in-page dispatch, so games that listen on the document receive them.
 */

import type { Page } from "playwright";
import { AgentPlaytestError } from "../shared/errors.ts";

export type KeyAction = "keydown" | "keyup" | "press";

export async function keyAction(page: Page, action: KeyAction, key: string): Promise<string> {
  if (key.length === 0 || key.length > 64) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: `Key must be 1-64 characters (received ${JSON.stringify(key)}).`,
      hint: "Use Playwright key names such as ArrowRight, Space, KeyW or a single character.",
    });
  }
  switch (action) {
    case "keydown":
      await page.keyboard.down(key);
      break;
    case "keyup":
      await page.keyboard.up(key);
      break;
    case "press":
      await page.keyboard.press(key);
      break;
  }
  return key;
}

export async function clickAt(page: Page, x: number, y: number): Promise<string> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: "click requires finite viewport CSS pixel coordinates: x and y.",
    });
  }
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: `click coordinates (${x}, ${y}) are outside the ${viewport.width}x${viewport.height} viewport.`,
    });
  }
  await page.mouse.click(x, y);
  return `${x},${y}`;
}
