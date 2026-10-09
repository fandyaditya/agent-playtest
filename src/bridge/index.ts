/**
 * `agent-playtest/bridge` — the development-only in-page bridge.
 *
 * This module is imported by the *consumer's* game code (through
 * `.agent-playtest/bridge.ts`) and runs inside the browser. It must never import Node
 * APIs, and it must never be active in a production build.
 */

import { AgentPlaytestError, capabilityError } from "../shared/errors.ts";
import {
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  type CapabilityKey,
  type CaptureViewName,
  type EngineName,
  type GameCapabilities,
  type InspectOptions,
  type InspectResult,
  type SnapshotOptions,
  type SnapshotResult,
  type SnapshotWarning,
} from "../shared/types.ts";
import type { SubjectHint } from "./adapter.ts";
import { ThreeAdapter } from "./adapters/three.ts";
import type { Object3DLike } from "./adapters/three-types.ts";
import { type BeginCaptureResult, beginCapture, endAllCaptures, endCapture } from "./capture.ts";
import { parseRef, RefRegistry, resolveSelector } from "./registry.ts";
import { buildSnapshot, createSnapshotState, type SnapshotState } from "./snapshot.ts";

export type { SubjectHint } from "./adapter.ts";
export type { Object3DLike } from "./adapters/three-types.ts";

export interface SimulationHooks {
  pause?(): void | Promise<void>;
  step?(dtSeconds: number): void | Promise<void>;
  reset?(fixture?: string): void | Promise<void>;
  state?(subject?: string): unknown;
  action?(name: string, args: unknown): void | Promise<void>;
}

export interface PhysicsHooks {
  inspectBody?(subject: string): unknown;
  contacts?(subject: string): unknown;
}

export interface ConnectOptions {
  engine: EngineName;
  scene?: unknown;
  camera?: unknown;
  renderer?: unknown;
  subjects?: Record<string, SubjectHint>;
  simulation?: SimulationHooks;
  physics?: PhysicsHooks;
  /** Optional game-readiness probe; when absent, readiness is reported unknown. */
  ready?: () => boolean | Promise<boolean>;
}

export interface SimulationApi {
  pause(): Promise<void>;
  step(ticks: number, dtSeconds?: number): Promise<{ ticks: number; warnings: string[] }>;
  reset(fixture?: string): Promise<void>;
  state(subject?: string): Promise<unknown>;
  action(name: string, args: unknown): Promise<void>;
}

export interface PhysicsApi {
  inspectBody(subject: string): Promise<unknown>;
  contacts(subject: string): Promise<unknown>;
}

/** Shape of the page global consumed by the Node-side driver. */
export interface PageBridgeApi {
  readonly version: number;
  readonly engine: EngineName;
  capabilities(): GameCapabilities;
  ready(): boolean | Promise<boolean> | undefined;
  snapshot(options: SnapshotOptions): SnapshotResult;
  inspect(selector: string, options: InspectOptions): InspectResult;
  beginCapture(options: { selector: string; view: CaptureViewName }): BeginCaptureResult;
  endCapture(token: string): { warnings: string[] };
  simulation: SimulationApi | null;
  physics: PhysicsApi | null;
  dispose(): void;
}

const MAX_TICKS_PER_REQUEST = 10_000;
const DEFAULT_TICK_SECONDS = 1 / 60;

export function connect(options: ConnectOptions): PageBridgeApi {
  if (options.engine !== "three") {
    throw new AgentPlaytestError({
      code: "CAPABILITY_UNAVAILABLE",
      message: `Engine "${options.engine}" is not implemented in this Agent Playtest version.`,
      missing: [`adapter.${options.engine}`],
      hint: "Three.js is the only shipped adapter in V1; a Phaser adapter is planned.",
    });
  }
  const scene = options.scene as Object3DLike | undefined;
  const camera = options.camera as never;
  const renderer = options.renderer as never;
  if (!scene || !camera || !renderer) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: "connect({ engine: 'three' }) requires scene, camera and renderer references.",
      hint: "Pass the real game objects, not a placeholder.",
    });
  }

  const adapter = new ThreeAdapter({
    scene,
    camera,
    renderer,
    subjects: options.subjects,
  });
  const registry = new RefRegistry();
  const snapshotState: SnapshotState = createSnapshotState();

  const simulation = options.simulation ? createSimulationApi(options.simulation) : null;
  const physics = options.physics ? createPhysicsApi(options.physics) : null;

  const resolveTarget = (selector: string): { object: Object3DLike; warnings: string[] } => {
    const value = selector.trim();
    if (parseRef(value) !== null) {
      const object = registry.resolve(value);
      if (object) return { object: object as Object3DLike, warnings: [] };
      if (registry.isKnown(value)) {
        throw new AgentPlaytestError({
          code: "STALE_REF",
          message: `Ref ${value} no longer refers to an object in this scene generation.`,
          hint: "Run `agent-playtest snapshot` again to obtain current refs.",
        });
      }
      throw new AgentPlaytestError({
        code: "OBJECT_NOT_FOUND",
        message: `Unknown ref ${value}.`,
        hint: "Refs are session-local: run `agent-playtest snapshot` first.",
      });
    }

    const resolution = resolveSelector<Object3DLike>(value, {
      candidates: adapter.all(),
      idOf: (object) => adapter.persistentIdOf(object),
      nameOf: (object) => adapter.nameOf(object),
      engineTypeOf: (object) => adapter.engineTypeOf(object),
    });
    if (resolution.kind === "found") {
      return { object: resolution.object, warnings: resolution.warnings };
    }
    if (resolution.kind === "ambiguous") {
      throw new AgentPlaytestError({
        code: "INVALID_ARGUMENT",
        message: resolution.message,
        hint: `Candidates: ${resolution.matches.slice(0, 10).join(", ")}`,
      });
    }
    throw new AgentPlaytestError({ code: "OBJECT_NOT_FOUND", message: resolution.message });
  };

  const api: PageBridgeApi = {
    version: BRIDGE_VERSION,
    engine: adapter.engine,

    capabilities(): GameCapabilities {
      const features = emptyFeatures();
      const sources: Record<string, "browser" | "bridge"> = {};
      for (const [key, value] of Object.entries(adapter.features())) {
        if (value === true) {
          features[key as CapabilityKey] = true;
          sources[key] = "bridge";
        }
      }
      if (simulation) {
        for (const key of [
          "simulation.pause",
          "simulation.step",
          "simulation.reset",
          "simulation.state",
          "simulation.action",
        ] as const) {
          features[key] = true;
          sources[key] = "bridge";
        }
      }
      if (physics) {
        features["physics.inspectBody"] = true;
        features["physics.contacts"] = true;
        sources["physics.inspectBody"] = "bridge";
        sources["physics.contacts"] = "bridge";
      }
      return {
        engine: adapter.engine,
        bridgeVersion: BRIDGE_VERSION,
        features,
        notes: adapter.notes(),
        sources,
      };
    },

    ready(): boolean | Promise<boolean> | undefined {
      return options.ready?.();
    },

    snapshot(snapshotOptions: SnapshotOptions): SnapshotResult {
      return buildSnapshot(adapter, registry, snapshotState, snapshotOptions ?? {});
    },

    inspect(selector: string, inspectOptions: InspectOptions): InspectResult {
      const { object, warnings: selectorWarnings } = resolveTarget(selector);
      const ref =
        parseRef(selector.trim()) !== null ? selector.trim() : registry.refFor(object as object);
      const partial = adapter.inspect(object, inspectOptions ?? {});
      const warnings: SnapshotWarning[] = [
        ...adapter.quickWarnings(object, ref),
        ...inspectionWarnings(partial),
      ];
      const capabilities = api.capabilities();
      const result: InspectResult = {
        ref,
        name: partial.name ?? adapter.nameOf(object),
        kind: partial.kind ?? adapter.kindOf(object),
        engineType: partial.engineType ?? adapter.engineTypeOf(object),
        coordinateSpace: partial.coordinateSpace ?? "unknown",
        capabilities,
        warnings,
        ...partial,
      };
      const id = adapter.persistentIdOf(object);
      if (id) result.selector = `agent-playtest:id=${id}`;
      if (selectorWarnings.length > 0) {
        result.warnings = [
          ...result.warnings,
          ...selectorWarnings.map<SnapshotWarning>((message) => ({
            check: "selector.approximate",
            message,
            confidence: "medium",
          })),
        ];
      }
      return result;
    },

    beginCapture({ selector, view }): BeginCaptureResult {
      const { object } = resolveTarget(selector);
      return beginCapture(
        { adapter, scene, camera: adapter.camera, renderer: adapter.renderer },
        object,
        view,
      );
    },

    endCapture(token: string): { warnings: string[] } {
      return endCapture(token);
    },

    simulation,
    physics,

    dispose(): void {
      endAllCaptures();
      simulation?.dispose?.();
      physics?.dispose?.();
      adapter.dispose();
      const globalScope = globalThis as unknown as Record<string, unknown>;
      if (globalScope[BRIDGE_GLOBAL] === api) delete globalScope[BRIDGE_GLOBAL];
    },
  };

  const globalScope = globalThis as unknown as Record<string, unknown>;
  const previous = globalScope[BRIDGE_GLOBAL] as PageBridgeApi | undefined;
  if (previous && typeof previous.dispose === "function") {
    // Hot module replacement / double init: never accumulate listeners or refs.
    previous.dispose();
    log("Agent Playtest bridge re-registered; the previous connection was disposed.");
  }
  globalScope[BRIDGE_GLOBAL] = api;
  return api;
}

function createSimulationApi(hooks: SimulationHooks): SimulationApi & { dispose(): void } {
  return {
    async pause(): Promise<void> {
      requireHook(hooks.pause, "simulation.pause");
      await hooks.pause();
    },
    async step(
      ticks: number,
      dtSeconds = DEFAULT_TICK_SECONDS,
    ): Promise<{ ticks: number; warnings: string[] }> {
      requireHook(hooks.pause, "simulation.pause");
      requireHook(hooks.step, "simulation.step");
      if (!Number.isInteger(ticks) || ticks < 1) {
        throw new AgentPlaytestError({
          code: "INVALID_ARGUMENT",
          message: `Tick count must be a positive integer (received ${ticks}).`,
        });
      }
      if (ticks > MAX_TICKS_PER_REQUEST) {
        throw new AgentPlaytestError({
          code: "INVALID_ARGUMENT",
          message: `Tick count ${ticks} exceeds the per-request limit of ${MAX_TICKS_PER_REQUEST}.`,
        });
      }
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > 1) {
        throw new AgentPlaytestError({
          code: "INVALID_ARGUMENT",
          message: `Timestep must be a finite number in (0, 1] seconds (received ${dtSeconds}).`,
        });
      }
      // The normal loop must be paused first, otherwise manual stepping races it.
      await hooks.pause();
      for (let index = 0; index < ticks; index += 1) {
        await hooks.step(dtSeconds);
        if (index > 0 && index % 30 === 0) await yieldToBrowser();
      }
      return {
        ticks,
        warnings: [
          `Stepped ${ticks} ticks at dt=${dtSeconds}s with the normal render loop paused; the game remains paused until the project resumes it.`,
          "Determinism is only guaranteed for systems driven by this timestep. Wall-clock timers, workers and server time are not advanced.",
        ],
      };
    },
    async reset(fixture?: string): Promise<void> {
      requireHook(hooks.reset, "simulation.reset");
      await hooks.reset(fixture);
    },
    async state(subject?: string): Promise<unknown> {
      requireHook(hooks.state, "simulation.state");
      return await hooks.state(subject);
    },
    async action(name: string, args: unknown): Promise<void> {
      requireHook(hooks.action, "simulation.action");
      await hooks.action(name, args);
    },
    dispose(): void {},
  };
}

function createPhysicsApi(hooks: PhysicsHooks): PhysicsApi & { dispose(): void } {
  return {
    async inspectBody(subject: string): Promise<unknown> {
      requireHook(hooks.inspectBody, "physics.inspectBody");
      return await hooks.inspectBody(subject);
    },
    async contacts(subject: string): Promise<unknown> {
      requireHook(hooks.contacts, "physics.contacts");
      return await hooks.contacts(subject);
    },
    dispose(): void {},
  };
}

function requireHook<T>(hook: T | undefined, name: string): asserts hook is T {
  if (typeof hook !== "function") {
    throw capabilityError(
      `${name} is not connected for this project.`,
      [name],
      "Add the optional hook in .agent-playtest/bridge.ts (see .agent-playtest/AGENTS.md).",
    );
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function inspectionWarnings(partial: Partial<InspectResult>): SnapshotWarning[] {
  const warnings: SnapshotWarning[] = [];
  if (!partial.bounds) {
    warnings.push({
      check: "bounds.unavailable",
      confidence: "medium",
      message: "No world-space bounds could be computed (no geometry, or non-finite transforms).",
    });
  } else {
    const size = partial.bounds.size;
    if (size.every((value) => value < 1e-6)) {
      warnings.push({
        check: "bounds.zero-size",
        confidence: "medium",
        message: "The subject has effectively zero size; it may be hidden or not yet loaded.",
      });
    }
  }
  if (partial.visible === false) {
    warnings.push({
      check: "visibility.hidden",
      confidence: "low",
      message:
        "The subject is currently invisible. This is expected for helper objects and temporarily hidden parts; it is only a defect if the object should be on screen.",
    });
  }
  for (const material of partial.materials ?? []) {
    for (const texture of material.textures) {
      if (texture.imageWidth === undefined || texture.imageHeight === undefined) {
        warnings.push({
          check: "texture.image-missing",
          confidence: "medium",
          message: `Texture "${texture.name}" on material "${material.name}" has no decoded image; it may not have finished loading.`,
        });
      }
    }
  }
  if (partial.skeleton && (partial.animations ?? []).length === 0) {
    warnings.push({
      check: "animations.unregistered",
      confidence: "medium",
      message:
        "A skeleton is present but no animation clips are registered, so animation names cannot be verified.",
    });
  }
  return warnings;
}

function emptyFeatures(): Record<CapabilityKey, boolean> {
  return {
    "scene.snapshot": false,
    "scene.inspect": false,
    "capture.page": false,
    "capture.object": false,
    "input.keyboard": false,
    "input.pointer": false,
    "simulation.pause": false,
    "simulation.step": false,
    "simulation.reset": false,
    "simulation.state": false,
    "simulation.action": false,
    "physics.inspectBody": false,
    "physics.contacts": false,
    "animations.inspect": false,
  };
}

function log(message: string): void {
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[agent-playtest] ${message}`);
  }
}
