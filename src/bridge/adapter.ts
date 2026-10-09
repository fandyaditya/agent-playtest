/**
 * Engine adapter contract.
 *
 * One common contract keeps the CLI, the driver and the test fixture
 * engine-agnostic: Three.js ships first, Phaser second. Adapters never depend on
 * CLI internals and never receive Node APIs.
 */

import type {
  CapabilityKey,
  CaptureViewName,
  EngineName,
  GameObjectKind,
  GameObjectSummary,
  InspectOptions,
  InspectResult,
  RenderStats,
  SnapshotWarning,
} from "../shared/types.ts";
import type { Bounds3 } from "./serialization.ts";

export interface TraverseOptions {
  depth: number;
  limit: number;
}

export interface TraverseEntry<T> {
  object: T;
  parent: T | null;
  depth: number;
}

export interface TraverseResult<T> {
  entries: TraverseEntry<T>[];
  /** Objects visited before limits were applied. */
  total: number;
  truncated: boolean;
}

export interface ViewPlan {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov?: number;
}

export interface SubjectHint {
  object: unknown;
  id?: string;
  forward?: [number, number, number];
  up?: [number, number, number];
  animations?: unknown;
  role?: string;
}

export interface EngineAdapter<T = unknown> {
  readonly engine: EngineName;
  sceneName(): string | undefined;

  /** Deterministic pre-order traversal, bounded by depth and object limit. */
  traverse(options: TraverseOptions): TraverseResult<T>;
  /** Full candidate list used to resolve persistent selectors. */
  all(): T[];
  nameOf(object: T): string;
  engineTypeOf(object: T): string;
  kindOf(object: T): GameObjectKind;
  persistentIdOf(object: T): string | undefined;
  isVisible(object: T): boolean | undefined;
  positionOf(object: T): number[] | undefined;
  childCountOf(object: T): number | undefined;
  animationOf(object: T): string | undefined;
  boundsOf(object: T): Bounds3 | null;

  summary(object: T, ref: string, parentRef: string | undefined): GameObjectSummary;
  /** Cheap structural checks, run for every snapshot object. */
  quickWarnings(object: T, ref: string): SnapshotWarning[];
  inspect(object: T, options: InspectOptions): Partial<InspectResult>;
  /** Sanitized JSON view of a project-registered subject, when available. */
  subjectHintFor(object: T): SubjectHint | undefined;

  /** Object capture needs a controllable camera; unsupported engines return false. */
  supportsObjectCapture(): boolean;
  viewPlan(object: T, view: CaptureViewName): ViewPlan | null;
  /** Forces one render through the driver's canvas; implemented by the bridge core. */
  renderStats(): RenderStats | undefined;

  features(): Partial<Record<CapabilityKey, boolean>>;
  notes(): string[];
  dispose(): void;
}
