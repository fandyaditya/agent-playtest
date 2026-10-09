import { describe, expect, it } from "vitest";
import { ThreeAdapter } from "../../src/bridge/adapters/three.ts";
import { fakeCamera, fakeRenderer, type ThreeNodeSpec, threeNode } from "./support/fakes.ts";

function cube(
  name: string,
  position: [number, number, number],
  extra: Partial<ThreeNodeSpec> = {},
) {
  return threeNode({
    name,
    type: "Mesh",
    isMesh: true,
    position,
    geometry: {
      type: "BoxGeometry",
      boundingBox: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      positionCount: 24,
      index: { count: 36 },
      groups: [{}],
      attributes: { position: { count: 24 }, normal: { count: 24 } },
    },
    ...extra,
  });
}

function arena() {
  return threeNode({
    name: "arena",
    type: "Scene",
    isScene: true,
    children: [
      threeNode({ name: "Sun", type: "DirectionalLight", isLight: true, position: [3, 6, 4] }),
      cube("Hero", [1, 0.4, 0], { agentPlaytest: { id: "main-hero" } }),
      threeNode({
        name: "Props",
        type: "Group",
        isGroup: true,
        children: [cube("Crate", [2, 0, 0])],
      }),
    ],
  });
}

function adapterFor(scene = arena(), subjects: Record<string, unknown> = {}) {
  const camera = fakeCamera(50);
  const renderer = fakeRenderer();
  const adapter = new ThreeAdapter({
    scene,
    camera,
    renderer: renderer as never,
    subjects: subjects as never,
  });
  return { adapter, camera, renderer, scene };
}

function expectVector(actual: number[] | undefined, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual?.[index]).toBeCloseTo(value, 6);
  });
}

describe("ThreeAdapter traversal", () => {
  it("walks pre-order and counts everything it did not show", () => {
    const { adapter } = adapterFor();
    const result = adapter.traverse({ depth: 1, limit: 10 });

    expect(result.entries.map((entry) => entry.object.name)).toEqual([
      "arena",
      "Sun",
      "Hero",
      "Props",
    ]);
    expect(result.entries.map((entry) => entry.depth)).toEqual([0, 1, 1, 1]);
    // `total` counts what the traversal window reached; Crate sits below depth 1.
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("respects the object limit", () => {
    const { adapter } = adapterFor();
    const result = adapter.traverse({ depth: 4, limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("all() reaches every object regardless of the default depth", () => {
    const { adapter } = adapterFor();
    expect(adapter.all().map((object) => object.name)).toEqual([
      "arena",
      "Sun",
      "Hero",
      "Props",
      "Crate",
    ]);
  });
});

describe("ThreeAdapter object identity", () => {
  it("maps engine flags to game object kinds", () => {
    const { adapter } = adapterFor();
    const [scene, sun, hero, props] = adapter.all();
    expect(adapter.kindOf(scene!)).toBe("scene");
    expect(adapter.kindOf(sun!)).toBe("light");
    expect(adapter.kindOf(hero!)).toBe("mesh");
    expect(adapter.kindOf(props!)).toBe("group");
  });

  it("reads the persistent id and the recommended selector", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    expect(adapter.persistentIdOf(hero)).toBe("main-hero");
    expect(adapter.summary(hero, "@g3", "@g1").selector).toBe("agent-playtest:id=main-hero");
    expect(adapter.summary(hero, "@g3", "@g1").parentRef).toBe("@g1");
  });

  it("names unnamed objects by their engine type instead of an empty string", () => {
    const { adapter } = adapterFor();
    const unnamed = threeNode({ name: "", type: "Mesh", isMesh: true });
    expect(adapter.nameOf(unnamed)).toBe("Mesh");
  });
});

describe("ThreeAdapter geometry facts", () => {
  it("computes world-space bounds through the node matrix", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    const bounds = adapter.boundsOf(hero);

    expectVector(bounds?.min, [0.5, -0.1, -0.5]);
    expectVector(bounds?.max, [1.5, 0.9, 0.5]);
  });

  it("returns null bounds when nothing in the subtree has geometry", () => {
    const { adapter } = adapterFor();
    const props = adapter.all()[3]!;
    const group = threeNode({ name: "Empty", type: "Group", isGroup: true });
    expect(adapter.boundsOf(group)).toBeNull();
    expect(adapter.boundsOf(props)).not.toBeNull();
  });

  it("reports geometry and material summaries on demand", () => {
    const { adapter } = adapterFor();
    const hero = cube("Hero", [0, 0, 0], {
      material: {
        type: "MeshStandardMaterial",
        name: "HeroSkin",
        color: { getHex: () => 0xff8800 },
        opacity: 0.5,
        transparent: true,
        side: 2,
      },
    });

    const summary = adapter.inspect(hero, { details: true });

    expect(summary.geometry?.type).toBe("BoxGeometry");
    expect(summary.geometry?.vertexCount).toBe(24);
    expect(summary.geometry?.indexCount).toBe(36);
    expect(summary.geometry?.groups).toBe(1);
    expect(summary.geometry?.attributes).toEqual(["normal", "position"]);
    expect(summary.materials?.[0]).toMatchObject({
      name: "HeroSkin",
      colorHex: "#ff8800",
      opacity: 0.5,
      transparent: true,
      side: 2,
    });
  });

  it("omits geometry attributes unless details are requested", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    expect(adapter.inspect(hero, {}).geometry?.attributes).toBeUndefined();
  });
});

describe("ThreeAdapter inspection", () => {
  it("reports world position, rotation, scale and bounds", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    const result = adapter.inspect(hero, {});

    expect(result.coordinateSpace).toBe("world-3d");
    expect(result.worldPosition).toEqual([1, 0.4, 0]);
    expect(result.localPosition).toEqual([1, 0.4, 0]);
    expect(result.rotation).toEqual([0, 0, 0]);
    expect(result.scale).toEqual([1, 1, 1]);
    expect(result.bounds?.size).toEqual([1, 1, 1]);
    expect(result.parent?.name).toBe("arena");
    expect(result.layers).toBe(1);
  });

  it("bounds the children list and says so", () => {
    const { adapter } = adapterFor();
    const scene = adapter.all()[0]!;
    const result = adapter.inspect(scene, { limit: 2 });

    expect(result.children).toHaveLength(2);
    expect(result.truncated).toContain("children");
  });

  it("includes skeleton and animation facts when the game exposes them", () => {
    const hero = cube("Hero", [0, 0, 0], { animations: [{ name: "Idle" }, { name: "Walk" }] });
    hero.skeleton = { bones: [{ name: "root" }, { name: "hand" }] } as never;
    const { adapter } = adapterFor(arena());

    const result = adapter.inspect(hero, { details: true });
    expect(result.skeleton?.bones).toBe(2);
    expect(result.skeleton?.rootName).toBe("root");
    expect(result.skeleton?.boneNames).toEqual(["root", "hand"]);
    expect(result.animations).toEqual(["Idle", "Walk"]);
  });

  it("reports renderer counters and labels them as last-frame only", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    const result = adapter.inspect(hero, { details: true });

    expect(result.renderStats).toEqual({
      drawCalls: 12,
      triangles: 4800,
      geometries: 7,
      textures: 3,
      programs: 2,
      frame: 91,
    });
    expect(adapter.notes().join(" ")).toContain("describe the last render only");
  });
});

describe("ThreeAdapter structural warnings", () => {
  it("flags non-finite transforms", () => {
    const broken = cube("Broken", [Number.NaN, 0, 0]);
    const { adapter } = adapterFor();
    const warnings = adapter.quickWarnings(broken, "@g9");
    expect(warnings.map((warning) => warning.check)).toContain("transform.invalid");
    expect(warnings[0]?.ref).toBe("@g9");
  });

  it("flags a zero scale component and a mesh without geometry", () => {
    const flat = cube("Flat", [0, 0, 0], { scale: [1, 0, 1] });
    const empty = threeNode({ name: "Empty", type: "Mesh", isMesh: true });
    const { adapter } = adapterFor();

    expect(adapter.quickWarnings(flat, "@g1").map((warning) => warning.check)).toContain(
      "transform.degenerate-scale",
    );
    expect(adapter.quickWarnings(empty, "@g2").map((warning) => warning.check)).toContain(
      "geometry.missing",
    );
  });

  it("says nothing about a healthy object", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    expect(adapter.quickWarnings(hero, "@g3")).toEqual([]);
  });
});

describe("ThreeAdapter object capture planning", () => {
  it("frames the subject from each requested view", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    const front = adapter.viewPlan(hero, "front");

    expect(front?.target).toEqual([1, 0.4, 0]);
    // Distance follows the documented fit rule for a unit cube at a 50 degree fov.
    const radius = Math.hypot(1, 1, 1) / 2;
    const distance = (radius * 1.35) / Math.sin((50 * Math.PI) / 180 / 2);
    expectVector(front?.eye, [1, 0.4, -distance]);
    expect(front?.up).toEqual([0, 1, 0]);
  });

  it("has no plan for the live camera view or for a subject without bounds", () => {
    const { adapter } = adapterFor();
    const hero = adapter.all()[2]!;
    expect(adapter.viewPlan(hero, "current")).toBeNull();
    expect(adapter.viewPlan(threeNode({ name: "Empty" }), "front")).toBeNull();
  });

  it("uses the subject's own forward axis when the project registers one", () => {
    const hero = cube("Hero", [0, 0, 0], { agentPlaytest: { id: "main-hero" } });
    const scene = threeNode({ name: "arena", isScene: true, children: [hero] });
    const { adapter } = adapterFor(scene, {
      hero: { object: hero, id: "main-hero", forward: [1, 0, 0] },
    });

    const plan = adapter.viewPlan(hero, "front");
    expect(plan?.eye[0]).toBeGreaterThan(0);
    expect(plan?.eye[2]).toBeCloseTo(0, 6);
  });

  it("reports capture.object as unavailable when the camera cannot be cloned", () => {
    const scene = arena();
    const camera = { fov: 50, name: "Fake" } as never;
    const adapter = new ThreeAdapter({
      scene,
      camera,
      renderer: fakeRenderer() as never,
    });

    expect(adapter.supportsObjectCapture()).toBe(false);
    expect(adapter.features()["capture.object"]).toBe(false);
    expect(adapter.notes().join(" ")).toContain("Object capture is unavailable");
  });
});

describe("ThreeAdapter capability reporting", () => {
  it("only claims animation inspection when clips are actually registered", () => {
    const hero = cube("Hero", [0, 0, 0]);
    const scene = threeNode({ name: "arena", isScene: true, children: [hero] });

    const without = adapterFor(scene).adapter;
    expect(without.features()["animations.inspect"]).toBe(false);
    expect(without.notes().join(" ")).toContain("No animation clips are registered");

    const withClips = adapterFor(scene, {
      hero: { object: hero, animations: [{ name: "Idle" }] },
    }).adapter;
    expect(withClips.features()["animations.inspect"]).toBe(true);
    expect(withClips.summary(hero, "@g2", "@g1").animation).toBe("Idle");
  });

  it("always claims the read-only capabilities it implements", () => {
    const { adapter } = adapterFor();
    expect(adapter.engine).toBe("three");
    expect(adapter.features()).toMatchObject({ "scene.snapshot": true, "scene.inspect": true });
    expect(adapter.sceneName()).toBe("arena");
  });

  it("drops registered subject hints on dispose", () => {
    const hero = cube("Hero", [0, 0, 0]);
    const scene = threeNode({ name: "arena", isScene: true, children: [hero] });
    const { adapter } = adapterFor(scene, {
      hero: { object: hero, animations: [{ name: "Idle" }] },
    });

    expect(adapter.subjectHintFor(hero)).toBeDefined();
    adapter.dispose();
    expect(adapter.subjectHintFor(hero)).toBeUndefined();
  });
});
