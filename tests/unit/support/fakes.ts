/**
 * Shared test doubles: a tiny structural Three.js-like graph and a minimal
 * `EngineAdapter` implementation.
 *
 * Both are deliberately plain objects. The adapters are written against
 * structural interfaces, so no real engine is needed to test snapshot,
 * selector and inspection behavior.
 */

import type {
  EngineAdapter,
  SubjectHint,
  TraverseEntry,
  TraverseOptions,
  TraverseResult,
  ViewPlan,
} from "../../../src/bridge/adapter.ts";
import type { CameraLike, Object3DLike } from "../../../src/bridge/adapters/three-types.ts";
import type { Bounds3 } from "../../../src/bridge/serialization.ts";
import { applyMatrix4ToPoint, roundNumber } from "../../../src/bridge/serialization.ts";
import type {
  CapabilityKey,
  CaptureViewName,
  GameObjectKind,
  GameObjectSummary,
  InspectOptions,
  InspectResult,
  RenderStats,
  SnapshotWarning,
} from "../../../src/shared/types.ts";

export interface FakeNode {
  name: string;
  type: string;
  kind: GameObjectKind;
  id?: string;
  animation?: string;
  visible?: boolean;
  position: [number, number, number];
  children: FakeNode[];
}

export function node(
  name: string,
  options: Partial<Omit<FakeNode, "name">> = {},
  ...children: FakeNode[]
): FakeNode {
  return {
    name,
    type: options.type ?? "Object3D",
    kind: options.kind ?? "group",
    position: options.position ?? [0, 0, 0],
    children: options.children ?? children,
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.animation === undefined ? {} : { animation: options.animation }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
  };
}

export class FakeAdapter implements EngineAdapter<FakeNode> {
  readonly engine = "custom" as const;
  #scene: FakeNode;
  #delegate: EngineAdapter<FakeNode> | null = null;

  constructor(scene: FakeNode) {
    this.#scene = scene;
  }

  sceneName(): string | undefined {
    return this.#scene.name;
  }

  traverse(options: TraverseOptions): TraverseResult<FakeNode> {
    const entries: TraverseEntry<FakeNode>[] = [];
    const stack: TraverseEntry<FakeNode>[] = [{ object: this.#scene, parent: null, depth: 0 }];
    let total = 0;
    let truncated = false;
    while (stack.length > 0) {
      const item = stack.pop() as TraverseEntry<FakeNode>;
      total += 1;
      if (entries.length < options.limit) entries.push(item);
      if (item.depth >= options.depth) {
        if (item.object.children.length > 0) truncated = true;
        continue;
      }
      for (let index = item.object.children.length - 1; index >= 0; index -= 1) {
        const child = item.object.children[index] as FakeNode;
        stack.push({ object: child, parent: item.object, depth: item.depth + 1 });
      }
    }
    if (entries.length < total) truncated = true;
    return { entries, total, truncated };
  }

  all(): FakeNode[] {
    return this.traverse({ depth: 64, limit: 10_000 }).entries.map((entry) => entry.object);
  }

  nameOf(object: FakeNode): string {
    return object.name;
  }

  engineTypeOf(object: FakeNode): string {
    return object.type;
  }

  kindOf(object: FakeNode): GameObjectKind {
    return object.kind;
  }

  persistentIdOf(object: FakeNode): string | undefined {
    return object.id;
  }

  isVisible(object: FakeNode): boolean | undefined {
    return object.visible;
  }

  positionOf(object: FakeNode): number[] | undefined {
    return [...object.position];
  }

  childCountOf(object: FakeNode): number | undefined {
    return object.children.length;
  }

  animationOf(object: FakeNode): string | undefined {
    return object.animation;
  }

  boundsOf(object: FakeNode): Bounds3 | null {
    const half = 0.5;
    const [x, y, z] = object.position;
    return {
      min: [x - half, y - half, z - half],
      max: [x + half, y + half, z + half],
    };
  }

  summary(object: FakeNode, ref: string, parentRef: string | undefined): GameObjectSummary {
    const summary: GameObjectSummary = {
      ref,
      name: object.name,
      kind: object.kind,
      engineType: object.type,
      position: [...object.position],
      childCount: object.children.length,
    };
    if (object.id) summary.selector = `gameprob:id=${object.id}`;
    if (parentRef) summary.parentRef = parentRef;
    if (object.visible !== undefined) summary.visible = object.visible;
    if (object.animation) summary.animation = object.animation;
    return summary;
  }

  quickWarnings(object: FakeNode, ref: string): SnapshotWarning[] {
    if (object.position.some((component) => !Number.isFinite(component))) {
      return [
        {
          check: "transform.invalid",
          ref,
          confidence: "high",
          message: "position contains a non-finite component (NaN/Infinity).",
        },
      ];
    }
    return [];
  }

  inspect(object: FakeNode, _options: InspectOptions): Partial<InspectResult> {
    return {
      name: object.name,
      kind: object.kind,
      engineType: object.type,
      coordinateSpace: "world-3d",
      worldPosition: [...object.position],
    };
  }

  subjectHintFor(_object: FakeNode): SubjectHint | undefined {
    return undefined;
  }

  supportsObjectCapture(): boolean {
    return true;
  }

  viewPlan(_object: FakeNode, view: CaptureViewName): ViewPlan | null {
    if (view === "current") return null;
    return { eye: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0] };
  }

  renderStats(): RenderStats | undefined {
    return undefined;
  }

  features(): Partial<Record<CapabilityKey, boolean>> {
    return { "scene.snapshot": true, "scene.inspect": true };
  }

  notes(): string[] {
    return [];
  }

  dispose(): void {
    this.#delegate?.dispose();
    this.#delegate = null;
  }
}

/** Minimal Three.js-like node used by the real Three adapter tests. */
export interface ThreeFakeLike extends Object3DLike {
  children: ThreeFakeLike[];
}

export interface ThreeNodeSpec {
  name?: string;
  type?: string;
  isScene?: boolean;
  isMesh?: boolean;
  isGroup?: boolean;
  isLight?: boolean;
  isCamera?: boolean;
  isSkinnedMesh?: boolean;
  visible?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  gameprob?: { id?: string; animation?: string };
  geometry?: {
    type?: string;
    boundingBox?: { min: [number, number, number]; max: [number, number, number] };
    positionCount?: number;
    attributes?: Record<string, unknown>;
    index?: { count: number };
    groups?: unknown[];
  };
  material?: unknown;
  animations?: Array<{ name: string }>;
  children?: Array<ThreeNodeSpec | ThreeFakeLike>;
}

/**
 * Builds a structurally Three-like graph. `matrixWorld` is a plain translation
 * matrix built from the node's own position and its ancestors, which is all the
 * adapter reads.
 */
export function threeNode(spec: ThreeNodeSpec): ThreeFakeLike {
  const position = spec.position ?? [0, 0, 0];
  const rotation = spec.rotation ?? [0, 0, 0];
  const scale = spec.scale ?? [1, 1, 1];

  const node: ThreeFakeLike = {
    name: spec.name ?? "",
    type: spec.type ?? "Object3D",
    uuid: `uuid-${spec.name}`,
    visible: spec.visible ?? true,
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: { x: rotation[0], y: rotation[1], z: rotation[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    isScene: spec.isScene ?? false,
    isMesh: spec.isMesh ?? false,
    isGroup: spec.isGroup ?? false,
    isLight: spec.isLight ?? false,
    isCamera: spec.isCamera ?? false,
    isSkinnedMesh: spec.isSkinnedMesh ?? false,
    children: [],
    parent: null,
    layers: { mask: 1 },
    userData: spec.gameprob ? { gameprob: spec.gameprob } : {},
    updateWorldMatrix(): void {},
    matrixWorld: { elements: identityWithTranslation(position) },
  } as unknown as ThreeFakeLike;

  if (spec.geometry) {
    const geometry = spec.geometry;
    node.geometry = {
      type: geometry.type ?? "BoxGeometry",
      boundingBox: geometry.boundingBox
        ? {
            min: vector3(geometry.boundingBox.min),
            max: vector3(geometry.boundingBox.max),
          }
        : undefined,
      attributes: geometry.attributes ?? { position: { count: geometry.positionCount ?? 24 } },
      index: geometry.index,
      groups: geometry.groups,
      computeBoundingBox(): void {},
    } as unknown as Object3DLike["geometry"];
  }
  if (spec.material !== undefined) node.material = spec.material;
  if (spec.animations) node.animations = spec.animations;

  for (const childSpec of spec.children ?? []) {
    const child = isThreeFake(childSpec) ? childSpec : threeNode(childSpec);
    child.parent = node;
    (node.children as ThreeFakeLike[]).push(child);
  }
  return node;
}

function isThreeFake(value: ThreeNodeSpec | ThreeFakeLike): value is ThreeFakeLike {
  // Fakes always carry a matrixWorld; specs never do.
  return (value as ThreeFakeLike).matrixWorld !== undefined;
}

export function fakeCamera(fov = 50): CameraLike {
  return {
    fov,
    isCamera: true,
    type: "PerspectiveCamera",
    name: "FakeCamera",
    children: [],
    clone(): CameraLike {
      return fakeCamera(fov);
    },
  } as unknown as CameraLike;
}

export function fakeRenderer(): { info: Record<string, unknown>; render: () => void } {
  return {
    info: {
      render: { calls: 12, triangles: 4800, frame: 91 },
      memory: { geometries: 7, textures: 3 },
      programs: [{}, {}],
    },
    render(): void {},
  };
}

function vector3(values: [number, number, number]): {
  x: number;
  y: number;
  z: number;
  clone(): unknown;
} {
  return {
    x: values[0],
    y: values[1],
    z: values[2],
    clone() {
      return vector3(values);
    },
  };
}

function identityWithTranslation(position: [number, number, number]): Float32Array | number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, position[0], position[1], position[2], 1];
}

/** Convenience: world-space origin of a point through a node's matrix. */
export function worldPointOf(node: ThreeFakeLike, x = 0, y = 0, z = 0): [number, number, number] {
  const elements = node.matrixWorld?.elements ?? [];
  return applyMatrix4ToPoint(elements, x, y, z).map((value) => roundNumber(value)) as [
    number,
    number,
    number,
  ];
}
