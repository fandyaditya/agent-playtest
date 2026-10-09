/**
 * Three.js adapter — the first engine, and the reference implementation of the
 * shared adapter contract.
 *
 * Read-only in V1: it observes objects, and can temporarily render an object
 * through a cloned inspection camera. It never mutates game state permanently.
 */

import type {
  CapabilityKey,
  CaptureViewName,
  EngineName,
  GameObjectKind,
  GameObjectSummary,
  GeometrySummary,
  InspectChildRef,
  InspectOptions,
  InspectResult,
  MaterialSummary,
  RenderStats,
  SnapshotWarning,
} from "../../shared/types.ts";
import type {
  EngineAdapter,
  SubjectHint,
  TraverseEntry,
  TraverseOptions,
  TraverseResult,
  ViewPlan,
} from "../adapter.ts";
import type { Bounds3 } from "../serialization.ts";
import {
  applyMatrix4ToPoint,
  boundArray,
  boundsAreValid,
  colorToHex,
  emptyBounds,
  expandBounds,
  finiteNumber,
  readEuler,
  readVector,
  roundNumber,
  safeString,
} from "../serialization.ts";
import {
  type CameraLike,
  looksLikeHelper,
  type Object3DLike,
  readGameProbMeta,
  type WebGLRendererLike,
} from "./three-types.ts";

const HARD_VISIT_CAP = 100_000;
const DEFAULT_FORWARD: [number, number, number] = [0, 0, -1];
const DEFAULT_UP: [number, number, number] = [0, 1, 0];

export interface ThreeAdapterOptions {
  scene: Object3DLike;
  camera: CameraLike;
  renderer: WebGLRendererLike;
  subjects?: Record<string, SubjectHint | undefined>;
}

export class ThreeAdapter implements EngineAdapter<Object3DLike> {
  readonly engine: EngineName = "three";

  #scene: Object3DLike;
  #camera: CameraLike;
  #renderer: WebGLRendererLike;
  #hints = new Map<object, SubjectHint>();

  constructor(options: ThreeAdapterOptions) {
    this.#scene = options.scene;
    this.#camera = options.camera;
    this.#renderer = options.renderer;
    for (const hint of Object.values(options.subjects ?? {})) {
      if (hint && typeof hint === "object" && hint.object) {
        this.#hints.set(hint.object as object, hint);
      }
    }
  }

  get camera(): CameraLike {
    return this.#camera;
  }

  get renderer(): WebGLRendererLike {
    return this.#renderer;
  }

  get scene(): Object3DLike {
    return this.#scene;
  }

  sceneName(): string | undefined {
    return safeString(this.#scene.name, 120) ?? undefined;
  }

  traverse(options: TraverseOptions): TraverseResult<Object3DLike> {
    const entries: TraverseEntry<Object3DLike>[] = [];
    const stack: Array<TraverseEntry<Object3DLike>> = [
      { object: this.#scene, parent: null, depth: 0 },
    ];
    let total = 0;
    let visited = 0;
    let truncated = false;

    while (stack.length > 0) {
      const item = stack.pop() as TraverseEntry<Object3DLike>;
      visited += 1;
      if (visited > HARD_VISIT_CAP) {
        truncated = true;
        break;
      }
      total += 1;
      if (entries.length < options.limit) entries.push(item);
      if (item.depth >= options.depth) {
        // Children below the depth limit are invisible to the caller, so the
        // result is incomplete even if the object limit was never reached.
        if ((item.object.children?.length ?? 0) > 0) truncated = true;
        continue;
      }
      const children = item.object.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) stack.push({ object: child, parent: item.object, depth: item.depth + 1 });
      }
    }

    if (entries.length < total) truncated = true;
    return { entries, total, truncated };
  }

  all(): Object3DLike[] {
    return this.traverse({ depth: 64, limit: HARD_VISIT_CAP }).entries.map((entry) => entry.object);
  }

  nameOf(object: Object3DLike): string {
    return safeString(object.name, 120) ?? this.engineTypeOf(object);
  }

  engineTypeOf(object: Object3DLike): string {
    return safeString(object.type, 60) ?? "Object3D";
  }

  kindOf(object: Object3DLike): GameObjectKind {
    if (object.isScene) return "scene";
    if (object.isSkinnedMesh) return "skinnedMesh";
    if (object.isMesh) return "mesh";
    if (object.isSprite) return "sprite";
    if (object.isCamera) return "camera";
    if (object.isLight) return "light";
    if (object.isPoints || object.isLine) return "other";
    if (object.isGroup) return "group";
    if ((object.children?.length ?? 0) > 0) return "group";
    return "other";
  }

  persistentIdOf(object: Object3DLike): string | undefined {
    return readGameProbMeta(object).id;
  }

  isVisible(object: Object3DLike): boolean | undefined {
    return typeof object.visible === "boolean" ? object.visible : undefined;
  }

  positionOf(object: Object3DLike): number[] | undefined {
    return readVector(object.position, 3);
  }

  childCountOf(object: Object3DLike): number | undefined {
    return object.children?.length ?? 0;
  }

  animationOf(object: Object3DLike): string | undefined {
    return readGameProbMeta(object).animation;
  }

  subjectHintFor(object: Object3DLike): SubjectHint | undefined {
    return this.#hints.get(object);
  }

  boundsOf(object: Object3DLike): Bounds3 | null {
    const bounds = emptyBounds();
    let found = false;

    const visit = (node: Object3DLike, depth: number): void => {
      if (depth > 64) return;
      if (node.geometry) {
        const box = geometryBounds(node);
        const elements = worldElements(node);
        if (box && elements) {
          for (let xi = 0; xi < 2; xi += 1) {
            for (let yi = 0; yi < 2; yi += 1) {
              for (let zi = 0; zi < 2; zi += 1) {
                const point = applyMatrix4ToPoint(
                  elements,
                  xi === 0 ? box.min[0] : box.max[0],
                  yi === 0 ? box.min[1] : box.max[1],
                  zi === 0 ? box.min[2] : box.max[2],
                );
                if (point.every((component) => Number.isFinite(component))) {
                  expandBounds(bounds, point);
                  found = true;
                }
              }
            }
          }
        }
      }
      for (const child of node.children ?? []) visit(child, depth + 1);
    };

    visit(object, 0);
    if (!found || !boundsAreValid(bounds)) return null;
    return bounds;
  }

  summary(object: Object3DLike, ref: string, parentRef: string | undefined): GameObjectSummary {
    const summary: GameObjectSummary = {
      ref,
      name: this.nameOf(object),
      kind: this.kindOf(object),
      engineType: this.engineTypeOf(object),
    };
    const id = this.persistentIdOf(object);
    if (id) summary.selector = `gameprob:id=${id}`;
    if (parentRef) summary.parentRef = parentRef;
    const visible = this.isVisible(object);
    if (visible !== undefined) summary.visible = visible;
    const position = this.positionOf(object);
    if (position && position.length === 3) {
      summary.position = [position[0] as number, position[1] as number, position[2] as number];
    }
    const childCount = this.childCountOf(object);
    if (childCount !== undefined) summary.childCount = childCount;
    const animation = this.animationOf(object) ?? this.#hintAnimation(object);
    if (animation) summary.animation = animation;
    return summary;
  }

  #hintAnimation(object: Object3DLike): string | undefined {
    const hint = this.#hints.get(object);
    if (!hint) return undefined;
    const clips = hint.animations;
    if (!Array.isArray(clips) || clips.length !== 1) return undefined;
    const only = clips[0] as { name?: unknown } | undefined;
    return safeString(only?.name, 80);
  }

  quickWarnings(object: Object3DLike, ref: string): SnapshotWarning[] {
    const warnings: SnapshotWarning[] = [];
    const components: Array<[string, number[] | undefined]> = [
      ["position", readEuler(object.position)],
      ["rotation", readEuler(object.rotation)],
      ["scale", readEuler(object.scale)],
    ];
    for (const [field, value] of components) {
      if (value === undefined) {
        warnings.push({
          check: "transform.invalid",
          ref,
          confidence: "high",
          message: `${field} contains a non-finite component (NaN/Infinity).`,
        });
      }
    }
    const scale = readEuler(object.scale);
    if (scale?.some((component) => component === 0)) {
      warnings.push({
        check: "transform.degenerate-scale",
        ref,
        confidence: "high",
        message: `scale has a zero component (${scale.join(", ")}); the object renders with zero size.`,
      });
    }
    if (object.isMesh && !object.geometry) {
      warnings.push({
        check: "geometry.missing",
        ref,
        confidence: "high",
        message: "Mesh has no geometry attached.",
      });
    }
    return warnings;
  }

  inspect(object: Object3DLike, options: InspectOptions): Partial<InspectResult> {
    const limit = options.limit ?? 50;
    const details = options.details === true;
    const result: Partial<InspectResult> = {
      name: this.nameOf(object),
      kind: this.kindOf(object),
      engineType: this.engineTypeOf(object),
      coordinateSpace: "world-3d",
    };
    const uuid = safeString(object.uuid, 64);
    if (uuid) result.uuid = uuid;
    const visible = this.isVisible(object);
    if (visible !== undefined) result.visible = visible;
    if (typeof object.layers?.mask === "number") result.layers = object.layers.mask;

    const local = readVector(object.position, 3, false);
    if (local) result.localPosition = local;
    const world = worldElements(object);
    if (world) {
      const point = applyMatrix4ToPoint(world, 0, 0, 0);
      if (point.every((component) => Number.isFinite(component))) {
        result.worldPosition = point.map((component) => roundNumber(component));
      }
    }
    const rotation = readEuler(object.rotation);
    if (rotation) result.rotation = rotation;
    const scale = readEuler(object.scale);
    if (scale) result.scale = scale;

    const parent = object.parent;
    if (parent) {
      const parentRef: InspectChildRef = {
        name: this.nameOf(parent),
        engineType: this.engineTypeOf(parent),
      };
      result.parent = parentRef;
    }
    if (object.children && object.children.length > 0) {
      const mapped = object.children.map<InspectChildRef>((child) => ({
        name: this.nameOf(child),
        engineType: this.engineTypeOf(child),
      }));
      const bounded = boundArray(mapped, limit);
      result.children = bounded.items;
      if (bounded.truncated) result.truncated = [...(result.truncated ?? []), "children"];
    }

    const bounds = this.boundsOf(object);
    if (bounds) {
      const min = bounds.min.map((v) => roundNumber(v));
      const max = bounds.max.map((v) => roundNumber(v));
      result.bounds = {
        min,
        max,
        size: [
          roundNumber(max[0]! - min[0]!),
          roundNumber(max[1]! - min[1]!),
          roundNumber(max[2]! - min[2]!),
        ],
      };
    }

    if (object.geometry) {
      result.geometry = this.#geometrySummary(object.geometry as never, details);
    }

    const materials = Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : [];
    if (materials.length > 0) {
      const bounded = boundArray(
        materials.map((material) => this.#materialSummary(material, details)),
        limit,
      );
      result.materials = bounded.items;
      if (bounded.truncated) result.truncated = [...(result.truncated ?? []), "materials"];
    }

    if (object.skeleton) {
      const bones = object.skeleton.bones ?? [];
      const skeleton: { bones: number; rootName?: string; boneNames?: string[] } = {
        bones: bones.length,
      };
      const first = bones[0] as Object3DLike | undefined;
      const rootName = safeString(first?.name, 120);
      if (rootName) skeleton.rootName = rootName;
      if (details) {
        const names = bones
          .map((bone) => safeString((bone as Object3DLike).name, 120))
          .filter((name): name is string => name !== undefined);
        const bounded = boundArray(names, limit);
        skeleton.boneNames = bounded.items;
        if (bounded.truncated)
          result.truncated = [...(result.truncated ?? []), "skeleton.boneNames"];
      }
      result.skeleton = skeleton;
    }

    const animations = this.#animationNames(object, limit);
    if (animations) {
      result.animations = animations;
      result.truncated = result.truncated ?? [];
    }

    if (details) {
      const stats = this.renderStats();
      if (stats) result.renderStats = stats;
    }

    return result;
  }

  #geometrySummary(
    geometry: NonNullable<Object3DLike["geometry"]>,
    details: boolean,
  ): GeometrySummary {
    const position = geometry.attributes?.position;
    const summary: GeometrySummary = {
      type: safeString(geometry.type, 60) ?? "BufferGeometry",
    };
    const vertexCount = finiteNumber(position?.count);
    if (vertexCount !== undefined) summary.vertexCount = Math.round(vertexCount);
    const indexCount = finiteNumber(geometry.index?.count);
    if (indexCount !== undefined) summary.indexCount = Math.round(indexCount);
    if (geometry.groups) summary.groups = geometry.groups.length;
    if (details && geometry.attributes) {
      summary.attributes = Object.keys(geometry.attributes).sort();
    }
    const box = geometryBounds({ geometry } as Object3DLike);
    if (box) {
      summary.bounds = {
        min: box.min.map((v) => roundNumber(v)),
        max: box.max.map((v) => roundNumber(v)),
        size: [
          roundNumber(box.max[0] - box.min[0]),
          roundNumber(box.max[1] - box.min[1]),
          roundNumber(box.max[2] - box.min[2]),
        ],
      };
    }
    return summary;
  }

  #materialSummary(material: unknown, details: boolean): MaterialSummary {
    const typed = (material ?? {}) as Record<string, unknown>;
    const summary: MaterialSummary = {
      name: safeString(typed.name, 120) ?? "(unnamed)",
      type: safeString(typed.type, 60) ?? "Material",
      textures: [],
    };
    const color = colorToHex(
      (typed.color as { getHex?: () => number } | undefined)?.getHex?.() ?? typed.color,
    );
    if (color) summary.colorHex = color;
    const opacity = finiteNumber(typed.opacity);
    if (opacity !== undefined) summary.opacity = roundNumber(opacity, 4);
    if (typeof typed.transparent === "boolean") summary.transparent = typed.transparent;
    const side = finiteNumber(typed.side);
    if (side !== undefined) summary.side = Math.round(side);
    if (details) {
      const slots = [
        "map",
        "normalMap",
        "roughnessMap",
        "metalnessMap",
        "emissiveMap",
        "alphaMap",
        "aoMap",
      ] as const;
      for (const slot of slots) {
        const texture = typed[slot] as
          | { name?: unknown; image?: { width?: unknown; height?: unknown } | null }
          | null
          | undefined;
        if (!texture) continue;
        const entry: { slot: string; name: string; imageWidth?: number; imageHeight?: number } = {
          slot,
          name: safeString(texture.name, 120) ?? "(unnamed texture)",
        };
        const width = finiteNumber(texture.image?.width);
        const height = finiteNumber(texture.image?.height);
        if (width !== undefined) entry.imageWidth = Math.round(width);
        if (height !== undefined) entry.imageHeight = Math.round(height);
        summary.textures.push(entry);
      }
    }
    return summary;
  }

  #animationNames(object: Object3DLike, limit: number): string[] | undefined {
    const hint = this.#hints.get(object);
    const clips = Array.isArray(hint?.animations)
      ? hint.animations
      : Array.isArray(object.animations)
        ? object.animations
        : undefined;
    if (!clips) return undefined;
    const names = clips
      .map((clip) => safeString((clip as { name?: unknown })?.name, 120))
      .filter((name): name is string => name !== undefined);
    return boundArray(names, limit).items;
  }

  renderStats(): RenderStats | undefined {
    const info = this.#renderer.info;
    if (!info) return undefined;
    const stats: RenderStats = {};
    const calls = finiteNumber(info.render?.calls);
    if (calls !== undefined) stats.drawCalls = Math.round(calls);
    const triangles = finiteNumber(info.render?.triangles);
    if (triangles !== undefined) stats.triangles = Math.round(triangles);
    const geometries = finiteNumber(info.memory?.geometries);
    if (geometries !== undefined) stats.geometries = Math.round(geometries);
    const textures = finiteNumber(info.memory?.textures);
    if (textures !== undefined) stats.textures = Math.round(textures);
    const programs = info.programs?.length;
    if (typeof programs === "number") stats.programs = programs;
    const frame = finiteNumber(info.render?.frame);
    if (frame !== undefined) stats.frame = Math.round(frame);
    return stats;
  }

  supportsObjectCapture(): boolean {
    return typeof this.#camera.clone === "function" && typeof this.#renderer.render === "function";
  }

  viewPlan(object: Object3DLike, view: CaptureViewName): ViewPlan | null {
    if (view === "current") return null;
    const bounds = this.boundsOf(object);
    if (!bounds) return null;
    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const size: [number, number, number] = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const radius = Math.max(
      Math.hypot(size[0], size[1], size[2]) / 2,
      Math.max(size[0], size[1], size[2]) / 2,
      0.001,
    );

    const hint = this.#hints.get(object);
    const elements = worldElements(object);
    const forward = orient(hint?.forward ?? DEFAULT_FORWARD, elements);
    const up = orient(hint?.up ?? DEFAULT_UP, elements);
    const right = normalize(cross(forward, up)) ?? [1, 0, 0];

    const directions: Record<Exclude<CaptureViewName, "current">, [number, number, number]> = {
      front: forward,
      back: negate(forward),
      right,
      left: negate(right),
      top: up,
      bottom: negate(up),
    };
    const direction = directions[view];

    const fov = finiteNumber(this.#camera.fov) ?? 50;
    const fovRadians = (Math.min(Math.max(fov, 5), 120) * Math.PI) / 180;
    const distance = (radius * 1.35) / Math.sin(fovRadians / 2);

    return {
      eye: [
        center[0] + direction[0] * distance,
        center[1] + direction[1] * distance,
        center[2] + direction[2] * distance,
      ],
      target: center,
      up,
      fov,
    };
  }

  features(): Partial<Record<CapabilityKey, boolean>> {
    const hasRegisteredAnimations = [...this.#hints.values()].some(
      (hint) => Array.isArray(hint.animations) && hint.animations.length > 0,
    );
    return {
      "scene.snapshot": true,
      "scene.inspect": true,
      "capture.object": this.supportsObjectCapture(),
      "animations.inspect": hasRegisteredAnimations,
    };
  }

  notes(): string[] {
    const notes: string[] = [];
    if (!this.supportsObjectCapture()) {
      notes.push("Object capture is unavailable: the renderer or camera could not be cloned.");
    }
    const hasRegisteredAnimations = [...this.#hints.values()].some(
      (hint) => Array.isArray(hint.animations) && hint.animations.length > 0,
    );
    if (!hasRegisteredAnimations) {
      notes.push(
        "No animation clips are registered. Animation names are only discoverable when the game exposes them through connect({ subjects }).",
      );
    }
    notes.push(
      "renderer.info counters describe the last render only; Three.js resets them each frame. They are not GPU frame timings.",
    );
    notes.push("Bounds for SkinnedMesh use the bind-pose geometry bounding box.");
    return notes;
  }

  dispose(): void {
    this.#hints.clear();
  }
}

function geometryBounds(
  node: Object3DLike,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const geometry = node.geometry;
  if (!geometry) return null;
  let box = geometry.boundingBox;
  if (!box && typeof geometry.computeBoundingBox === "function") {
    try {
      geometry.computeBoundingBox();
      box = geometry.boundingBox;
    } catch {
      return null;
    }
  }
  if (!box?.min || !box.max) return null;
  const min: [number, number, number] = [
    finiteNumber(box.min.x) ?? Number.NaN,
    finiteNumber(box.min.y) ?? Number.NaN,
    finiteNumber(box.min.z) ?? Number.NaN,
  ];
  const max: [number, number, number] = [
    finiteNumber(box.max.x) ?? Number.NaN,
    finiteNumber(box.max.y) ?? Number.NaN,
    finiteNumber(box.max.z) ?? Number.NaN,
  ];
  if ([...min, ...max].some((value) => !Number.isFinite(value))) return null;
  return { min, max };
}

function worldElements(node: Object3DLike): ArrayLike<number> | null {
  try {
    node.updateWorldMatrix?.(true, false);
  } catch {
    // A broken parent chain must not abort inspection.
  }
  const elements = node.matrixWorld?.elements;
  return elements && elements.length >= 16 ? elements : null;
}

function orient(
  vector: [number, number, number],
  elements: ArrayLike<number> | null,
): [number, number, number] {
  const base = normalize(vector) ?? DEFAULT_FORWARD;
  if (!elements) return base;
  const rotated = applyMatrix4ToPoint(elements, base[0], base[1], base[2]);
  const origin = applyMatrix4ToPoint(elements, 0, 0, 0);
  return (
    normalize([rotated[0] - origin[0], rotated[1] - origin[1], rotated[2] - origin[2]]) ?? base
  );
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function negate(a: [number, number, number]): [number, number, number] {
  return [-a[0], -a[1], -a[2]];
}

function normalize(vector: [number, number, number]): [number, number, number] | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export { looksLikeHelper };
