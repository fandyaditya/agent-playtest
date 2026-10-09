import { describe, expect, it } from "vitest";
import { RefRegistry } from "../../src/bridge/registry.ts";
import {
  buildSnapshot,
  createSnapshotState,
  resetSnapshotState,
} from "../../src/bridge/snapshot.ts";
import { FakeAdapter, node } from "./support/fakes.ts";

function scene() {
  return node(
    "arena",
    { kind: "scene", type: "Scene" },
    node("Hero", { kind: "mesh", type: "Mesh", id: "main-hero", position: [0, 0.4, 0] }),
    node(
      "Props",
      { kind: "group", type: "Group" },
      node("Crate", { kind: "mesh", type: "Mesh", position: [2, 0, 0] }),
    ),
  );
}

function setup(root = scene()) {
  const adapter = new FakeAdapter(root);
  const registry = new RefRegistry();
  const state = createSnapshotState();
  return { adapter, registry, state, root };
}

describe("buildSnapshot", () => {
  it("lists objects in hierarchy pre-order with refs and parents", () => {
    const { adapter, registry, state } = setup();
    const snapshot = buildSnapshot(adapter, registry, state, {});

    expect(snapshot.meta.mode).toBe("full");
    expect(snapshot.meta.engine).toBe("custom");
    expect(snapshot.meta.sceneName).toBe("arena");
    expect(snapshot.meta.revision).toBe(1);
    expect(snapshot.meta.objectsShown).toBe(4);
    expect(snapshot.meta.objectsTotal).toBe(4);
    expect(snapshot.meta.truncated).toBe(false);
    expect(snapshot.objects.map((object) => object.ref)).toEqual(["@g1", "@g2", "@g3", "@g4"]);
    expect(snapshot.objects.map((object) => object.name)).toEqual([
      "arena",
      "Hero",
      "Props",
      "Crate",
    ]);
    expect(snapshot.objects[1]?.parentRef).toBe("@g1");
    expect(snapshot.objects[3]?.parentRef).toBe("@g3");
    expect(snapshot.objects[1]?.selector).toBe("gameprob:id=main-hero");
    expect(snapshot.objects[1]?.position).toEqual([0, 0.4, 0]);
  });

  it("never truncates silently", () => {
    const { adapter, registry, state } = setup();
    const snapshot = buildSnapshot(adapter, registry, state, { depth: 1, limit: 2 });

    expect(snapshot.meta.truncated).toBe(true);
    expect(snapshot.meta.objectsShown).toBe(2);
    // `objectsTotal` counts what the traversal window could reach, not the whole graph.
    expect(snapshot.meta.objectsTotal).toBe(3);
    expect(snapshot.meta.depth).toBe(1);
    expect(snapshot.warnings.map((warning) => warning.check)).toContain("snapshot.limited");
    expect(
      snapshot.warnings.find((warning) => warning.check === "snapshot.limited")?.message,
    ).toContain("--depth/--limit");
  });

  it("reports the whole graph when only the object limit bites", () => {
    const { adapter, registry, state } = setup();
    const snapshot = buildSnapshot(adapter, registry, state, { depth: 8, limit: 2 });

    expect(snapshot.meta.objectsShown).toBe(2);
    expect(snapshot.meta.objectsTotal).toBe(4);
    expect(snapshot.meta.truncated).toBe(true);
  });

  it("always states the scope of its structural checks", () => {
    const { adapter, registry, state } = setup();
    const snapshot = buildSnapshot(adapter, registry, state, {});
    const scope = snapshot.warnings.find((warning) => warning.check === "checks.scope");
    expect(scope?.message).toContain("Zero warnings is not proof");
  });

  it("surfaces duplicate persistent ids as a warning", () => {
    const root = node(
      "arena",
      { kind: "scene", type: "Scene" },
      node("Hero", { kind: "mesh", type: "Mesh", id: "hero" }),
      node("Clone", { kind: "mesh", type: "Mesh", id: "hero" }),
    );
    const { adapter, registry, state } = setup(root);
    const snapshot = buildSnapshot(adapter, registry, state, {});

    expect(snapshot.warnings.map((warning) => warning.check)).toContain("selector.duplicate-id");
  });

  it("includes adapter structural warnings per object", () => {
    const root = node(
      "arena",
      { kind: "scene", type: "Scene" },
      node("Broken", { kind: "mesh", type: "Mesh", position: [Number.NaN, 0, 0] }),
    );
    const { adapter, registry, state } = setup(root);
    const snapshot = buildSnapshot(adapter, registry, state, {});

    const invalid = snapshot.warnings.find((warning) => warning.check === "transform.invalid");
    expect(invalid?.ref).toBe("@g2");
  });

  it("counts revisions across snapshots", () => {
    const { adapter, registry, state } = setup();
    buildSnapshot(adapter, registry, state, {});
    const second = buildSnapshot(adapter, registry, state, {});
    expect(second.meta.revision).toBe(2);
  });
});

describe("snapshot deltas", () => {
  it("falls back to a full snapshot when there is nothing to compare against", () => {
    const { adapter, registry, state } = setup();
    const snapshot = buildSnapshot(adapter, registry, state, { delta: true });

    expect(snapshot.meta.mode).toBe("full");
    expect(snapshot.delta).toBeUndefined();
  });

  it("reports added, updated and removed objects against the previous snapshot", () => {
    const root = scene();
    const { adapter, registry, state } = setup(root);
    buildSnapshot(adapter, registry, state, {});

    // Hero moves, one prop child disappears, one coin appears.
    const hero = root.children[0];
    const props = root.children[1];
    if (!hero || !props) throw new Error("unexpected fixture shape");
    hero.position = [1.52, 0.4, 0];
    props.children = [];
    root.children.push(node("Coin", { kind: "mesh", type: "Mesh" }));

    const delta = buildSnapshot(adapter, registry, state, { delta: true });

    expect(delta.meta.mode).toBe("delta");
    expect(delta.meta.baseRevision).toBe(1);
    expect(delta.delta?.added.map((object) => object.name)).toEqual(["Coin"]);
    expect(delta.delta?.removed).toEqual(["@g4"]);
    // A child-list change marks the parent updated too, so the tree change is visible.
    expect(delta.delta?.updated.map((object) => object.name)).toEqual(["arena", "Hero", "Props"]);
    expect(delta.meta.objectsShown).toBe(4);
  });

  it("resetSnapshotState forces the next delta to be full again", () => {
    const { adapter, registry, state } = setup();
    buildSnapshot(adapter, registry, state, {});
    resetSnapshotState(state);

    const snapshot = buildSnapshot(adapter, registry, state, { delta: true });
    expect(snapshot.meta.mode).toBe("full");
    expect(snapshot.delta).toBeUndefined();
  });
});
