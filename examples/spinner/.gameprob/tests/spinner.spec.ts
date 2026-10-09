import { expect, test } from "gameprob/test";

// These tests are the project's durable checks: no LLM, no guessing. They use
// persistent `gameprob:id=` selectors so they keep working across sessions.

test("the scene exposes the hero under a stable identity", async ({ game }) => {
  const snapshot = await game.snapshot();
  const hero = snapshot.objects.find((object) => object.selector === "gameprob:id=main-hero");
  expect(hero, "main-hero should be discoverable by persistent selector").toBeDefined();

  const inspected = await game.inspect("gameprob:id=main-hero");
  expect(inspected.visible).not.toBe(false);
  expect(inspected.bounds?.size[1] ?? 0).toBeGreaterThan(0);
});

test("the wall stops the hero instead of letting it pass through", async ({ game }) => {
  await game.reset("near-wall");
  const before = (await game.state()) as { heroX: number; maxHeroX: number };
  expect(before.heroX).toBeLessThanOrEqual(before.maxHeroX);

  await game.action("hold", { key: "ArrowRight" });
  await game.step(240);
  await game.action("release", { key: "ArrowRight" });

  const after = (await game.state()) as {
    heroX: number;
    maxHeroX: number;
    touchesWall: boolean;
    wallHits: number;
  };

  // The rule under test: the hero's centre never exceeds maxHeroX = 1.52.
  expect(after.heroX).toBeLessThanOrEqual(after.maxHeroX + 1e-9);
  expect(after.touchesWall).toBe(true);
  expect(after.wallHits).toBeGreaterThan(0);

  // And the object we inspected is the object that moved.
  const hero = await game.inspect("gameprob:id=main-hero");
  expect(hero.worldPosition?.[0]).toBeCloseTo(after.heroX, 5);
});

test("captures page and object evidence", async ({ game }) => {
  await game.reset("start");
  const page = await game.capture({ page: true, name: "spinner-page" });
  expect(page.views[0]?.nonBlank).toBe(true);

  const object = await game.capture({
    selector: "gameprob:id=main-hero",
    views: ["front", "right"],
    name: "hero",
  });
  expect(object.views).toHaveLength(2);
  for (const view of object.views) {
    expect(view.nonBlank).toBe(true);
    expect(view.width).toBeGreaterThan(0);
  }
});
