/**
 * Browser integration: the real CLI, a real daemon, a real Chromium and the
 * bundled example game. These assertions are the ones a unit test cannot make.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ActionResult,
  CaptureResult,
  OpenResult,
  SnapshotResult,
} from "../../src/shared/types.ts";
import {
  dataOf,
  EXAMPLE_ROOT,
  type ExampleServer,
  requireBuild,
  resetHome,
  runCli,
  startExampleServer,
} from "./harness.ts";

// Budgets, not expectations: these tests drive a real browser, and this project is
// developed on a single visible CPU where browser work can crawl. They must still
// be bounded, so each number is the ceiling, and the assertion is on content.
const TIMEOUT = 600_000;

interface InspectLike {
  name: string;
  kind: string;
  engineType: string;
  worldPosition?: number[];
  bounds?: { size: number[]; min: number[]; max: number[] };
}

describe("a full session against examples/spinner", () => {
  let server: ExampleServer;

  beforeAll(async () => {
    requireBuild();
    await runCli(["close"], { timeoutMs: 30_000 });
    resetHome();
    server = await startExampleServer();
  }, 60_000);

  afterAll(async () => {
    await runCli(["close"], { timeoutMs: 60_000 });
    await server?.stop();
  });

  it(
    "opens, inspects, drives, captures and closes the real game",
    async () => {
      const open = await runCli(["open", server.url, "--json"], { timeoutMs: 120_000 });
      const opened = dataOf<OpenResult>(open, "open");

      expect(open.code).toBe(0);
      expect(opened.url).toContain("agent-playtest=1");
      expect(opened.browser.toLowerCase()).toContain("chromium");
      expect(opened.bridge.connected).toBe(true);
      expect(opened.bridge.engine).toBe("three");
      expect(opened.readiness.domReady).toBe(true);
      expect(opened.readiness.gameReady).toBe(true);
      expect(opened.capabilities.features["scene.snapshot"]).toBe(true);
      expect(opened.capabilities.features["simulation.step"]).toBe(true);

      const snapshot = dataOf<SnapshotResult>(
        await runCli(["snapshot", "--json"], { timeoutMs: 120_000 }),
        "snapshot",
      );
      expect(snapshot.meta.engine).toBe("three");
      expect(snapshot.meta.sceneName).toBe("spinner-scene");
      expect(snapshot.meta.truncated).toBe(false);
      const hero = snapshot.objects.find(
        (object) => object.selector === "agent-playtest:id=main-hero",
      );
      expect(hero?.ref).toMatch(/^@g\d+$/);

      const before = dataOf<InspectLike>(
        await runCli(["inspect", "agent-playtest:id=main-hero", "--json"], { timeoutMs: 120_000 }),
        "inspect",
      );
      expect(before.kind).toBe("mesh");
      expect(before.engineType).toBe("Mesh");
      expect(before.worldPosition?.[0]).toBeCloseTo(0, 5);
      expect(before.bounds?.size[1]).toBeGreaterThan(0);

      // Real browser input, then deterministic stepping of the game loop.
      dataOf<ActionResult>(await runCli(["act", "keydown", "ArrowRight", "--json"]), "act keydown");
      const stepped = dataOf<ActionResult>(
        await runCli(["act", "step", "240", "--json"]),
        "act step",
      );
      expect(stepped.ticks).toBe(240);
      dataOf<ActionResult>(await runCli(["act", "keyup", "ArrowRight", "--json"]), "act keyup");

      const after = dataOf<InspectLike>(
        await runCli(["inspect", "agent-playtest:id=main-hero", "--json"], { timeoutMs: 120_000 }),
        "inspect",
      );
      // The wall clamp: the hero centre stops at MAX_HERO_X = 1.52.
      expect(after.worldPosition?.[0]).toBeGreaterThan(1.4);
      expect(after.worldPosition?.[0]).toBeLessThanOrEqual(1.5201);

      const page = dataOf<CaptureResult>(
        await runCli(
          [
            "capture",
            "--page",
            "--out",
            ".agent-playtest/output/page-int.png",
            "--overwrite",
            "--json",
          ],
          { timeoutMs: 180_000 },
        ),
        "capture --page",
      );
      expect(page.kind).toBe("page");
      expect(page.views).toHaveLength(1);
      expect(page.views[0]?.width).toBe(960);
      expect(page.views[0]?.height).toBe(540);
      expect(page.views[0]?.nonBlank).toBe(true);
      expect(page.views[0]?.bytes).toBeGreaterThan(1_000);
      expect(existsSync(join(EXAMPLE_ROOT, page.views[0]?.path ?? ""))).toBe(true);

      // Same command, same path, second time: `--overwrite` must be honoured
      // per call, not only when the file happens not to exist yet.
      const again = dataOf<CaptureResult>(
        await runCli(
          [
            "capture",
            "--page",
            "--out",
            ".agent-playtest/output/page-int.png",
            "--overwrite",
            "--json",
          ],
          { timeoutMs: 180_000 },
        ),
        "capture --page (overwrite)",
      );
      expect(again.views[0]?.path).toBe(page.views[0]?.path);
      expect(again.views[0]?.nonBlank).toBe(true);

      const object = dataOf<CaptureResult>(
        await runCli(
          [
            "capture",
            "agent-playtest:id=main-hero",
            "--views",
            "front,right",
            "--out",
            ".agent-playtest/output/hero-int",
            "--overwrite",
            "--json",
          ],
          { timeoutMs: 240_000 },
        ),
        "capture object",
      );
      expect(object.kind).toBe("object");
      expect(object.views.map((view) => view.view)).toEqual(["front", "right"]);
      for (const view of object.views) {
        expect(view.nonBlank).toBe(true);
        expect(view.width).toBeGreaterThan(0);
        expect(existsSync(join(EXAMPLE_ROOT, view.path))).toBe(true);
      }
      expect(object.manifestPath).toBeTruthy();

      const closed = dataOf<{ closed: boolean }>(await runCli(["close", "--json"]), "close");
      expect(closed.closed).toBe(true);

      // A second snapshot after close proves the session really ended.
      const orphaned = await runCli(["snapshot", "--json"], { timeoutMs: 60_000 });
      expect(orphaned.code).toBe(3);
    },
    TIMEOUT,
  );

  it("runs the project's own Playwright specs and reports their result", async () => {
    requireBuild();
    const result = await runCli(["run", "--json"], { timeoutMs: 1_200_000 });
    const run = dataOf<{
      expected: number;
      passed: number;
      failed: number;
      resultFile: string;
      runDir: string;
    }>(result, "run");

    expect(result.code).toBe(0);
    expect(run.expected).toBeGreaterThanOrEqual(3);
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(run.expected);
    expect(existsSync(join(EXAMPLE_ROOT, run.resultFile))).toBe(true);
  }, 1_320_000);
});
