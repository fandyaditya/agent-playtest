/**
 * Screenshot capture: file naming, path safety, PNG verification.
 *
 * Every artifact lands inside the project output root (or an explicit `--out`
 * path inside the project) and is verified to be a real PNG before it is
 * reported as a capture.
 */

import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { Page } from "playwright";
import { GameProbError } from "../shared/errors.ts";
import { atomicWriteBuffer, resolveInside } from "../shared/paths.ts";

export interface PngInfo {
  width: number;
  height: number;
  bytes: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngInfo(buffer: Buffer): PngInfo | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height, bytes: buffer.length };
}

export function timestampId(date = new Date()): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

export function slugify(value: string, fallback = "capture"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // A leading dot/dash could turn a generated file name into a hidden file
    // (or a parent-directory reference), so it is stripped, not escaped.
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}

/**
 * Capture the visible page.
 *
 * `animations: "disabled"` machinery is skipped on purpose: a game animates
 * through `requestAnimationFrame`, which that option does not touch, so it would
 * only add an animation/font handshake that can stall under software rendering.
 */
export async function screenshotPage(page: Page): Promise<Buffer> {
  return page.screenshot({ type: "png", fullPage: false });
}

export async function screenshotCanvas(page: Page): Promise<Buffer> {
  const canvases = page.locator("canvas");
  if ((await canvases.count()) === 0) {
    throw new GameProbError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "The page has no <canvas> element to capture.",
      missing: ["canvas"],
      hint: "Object capture requires a WebGL/2D canvas; use `capture --page` for the whole page.",
    });
  }
  const canvas = canvases.first();
  // Deliberately not `canvas.screenshot()`: an element screenshot waits for the
  // element to be stable and fails with "Element is not attached to the DOM"
  // when a game swaps or resizes its canvas. A clipped screenshot only needs one
  // measurement, and reports an honest error when there is none.
  await canvas.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await canvas.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    throw new GameProbError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "The <canvas> has no measurable size, so there is nothing to capture.",
      missing: ["canvas-size"],
      hint: "Make sure the canvas is visible and laid out before capturing.",
    });
  }

  // Measured on a software-rendered container: the CDP call is ~0.8s where
  // `page.screenshot` needs ~1.7-2.5s, because Playwright's wrapper also
  // disables CSS animations, waits for fonts and re-checks the viewport — none
  // of which affects a canvas game. Use it when the page speaks CDP and fall
  // back to the portable path otherwise.
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const result = (await session.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: false,
      })) as { data: string };
      return Buffer.from(result.data, "base64");
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return page.screenshot({ type: "png", clip });
  }
}

export interface WriteTarget {
  path: string;
  /** Relative to the project root, for durable records. */
  relative: string;
}

export function resolveWriteTarget(
  projectRoot: string,
  target: string,
  overwrite: boolean,
): WriteTarget {
  const absolute = resolveInside(projectRoot, target, "capture output path");
  if (existsSync(absolute) && !overwrite) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Refusing to overwrite existing file: ${absolute}`,
      hint: "Pass --overwrite to replace it, or choose a different --out path.",
    });
  }
  return { path: absolute, relative: relative(projectRoot, absolute) };
}

export function writePng(target: WriteTarget, buffer: Buffer): PngInfo {
  const info = readPngInfo(buffer);
  if (!info) {
    throw new GameProbError({
      code: "INTERNAL_ERROR",
      message: `The browser returned ${buffer.length} bytes that are not a valid PNG.`,
    });
  }
  atomicWriteBuffer(target.path, buffer, 0o644);
  return info;
}
