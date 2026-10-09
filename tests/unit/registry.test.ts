import { describe, expect, it } from "vitest";
import { parseRef, RefRegistry, resolveSelector } from "../../src/bridge/registry.ts";

interface Target {
  id?: string;
  name: string;
}

function source(candidates: Target[]) {
  return {
    candidates,
    idOf: (target: Target) => target.id,
    nameOf: (target: Target) => target.name,
    engineTypeOf: () => "Mesh",
  };
}

describe("RefRegistry", () => {
  it("hands out stable, unique refs for the same object", () => {
    const registry = new RefRegistry();
    const hero = { name: "hero" };
    const wall = { name: "wall" };

    expect(registry.refFor(hero)).toBe("@g1");
    expect(registry.refFor(wall)).toBe("@g2");
    expect(registry.refFor(hero)).toBe("@g1");
    expect(registry.size).toBe(2);
  });

  it("resolves refs back to objects and reports unknown ones as undefined", () => {
    const registry = new RefRegistry();
    const hero = { name: "hero" };
    const ref = registry.refFor(hero);

    expect(registry.resolve(ref)).toBe(hero);
    expect(registry.resolve("@g99")).toBeUndefined();
    expect(registry.isKnown("@g99")).toBe(false);
  });

  it("starts a new generation after navigation, invalidating old refs", () => {
    const registry = new RefRegistry();
    const hero = { name: "hero" };
    const before = registry.refFor(hero);

    registry.nextGeneration();
    expect(registry.generation).toBe(2);
    expect(registry.resolve(before)).toBeUndefined();

    const after = registry.refFor(hero);
    expect(after).toBe("@g1");
    expect(registry.isKnownButGone(before)).toBe(false);
    expect(registry.isKnown(after)).toBe(true);
  });

  it("prune drops refs the latest traversal did not see", () => {
    const registry = new RefRegistry();
    const hero = { name: "hero" };
    const stale = { name: "stale" };
    const keep = registry.refFor(hero);
    const drop = registry.refFor(stale);

    registry.prune(new Set([keep]));

    expect(registry.resolve(keep)).toBe(hero);
    expect(registry.resolve(drop)).toBeUndefined();
    expect(registry.isKnown(drop)).toBe(true);
    expect(registry.isKnownButGone(drop)).toBe(true);
  });
});

describe("parseRef", () => {
  it("accepts only @gN", () => {
    expect(parseRef("@g12")).toBe(12);
    expect(parseRef(" @g3 ")).toBe(3);
    expect(parseRef("@g0x")).toBeNull();
    expect(parseRef("g1")).toBeNull();
    expect(parseRef("name:hero")).toBeNull();
  });
});

describe("resolveSelector", () => {
  it("resolves a unique gameprob.id", () => {
    const result = resolveSelector(
      "gameprob:id=main-hero",
      source([{ id: "main-hero", name: "Hero" }, { name: "Wall" }]),
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.object.name).toBe("Hero");
  });

  it("reports a missing id instead of guessing", () => {
    const result = resolveSelector("gameprob:id=nope", source([{ name: "Hero" }]));
    expect(result.kind).toBe("missing");
  });

  it("rejects duplicate ids as ambiguous", () => {
    const result = resolveSelector(
      "gameprob:id=hero",
      source([
        { id: "hero", name: "Hero" },
        { id: "hero", name: "HeroClone" },
      ]),
    );
    expect(result.kind).toBe("ambiguous");
  });

  it("warns when a type selector matches several objects", () => {
    const result = resolveSelector("type:Mesh", source([{ name: "Hero" }, { name: "Wall" }]));
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.warnings[0]).toContain("matched 2 object(s)");
  });

  it("explains unrecognized selectors", () => {
    const result = resolveSelector("@g1", source([{ name: "Hero" }]));
    expect(result.kind).toBe("missing");
    if (result.kind === "missing") expect(result.message).toContain("Unrecognized selector");
  });
});
