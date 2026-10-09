/**
 * Shared DTOs and protocol constants.
 *
 * This module is imported by the CLI, the daemon, the browser driver, the
 * in-page bridge and the Playwright fixture. It MUST stay free of Node-only and
 * browser-only imports so it can be bundled into both targets.
 */

export const PROTOCOL_VERSION = 1;
export const CONFIG_SCHEMA_VERSION = 1;
export const BRIDGE_VERSION = 1;

/** Private-ish page global used to register the development-only bridge. */
export const BRIDGE_GLOBAL = "__GAMEPROB_BRIDGE__";

export type EngineName = "three" | "phaser" | "custom";

export type GameObjectKind =
  | "scene"
  | "group"
  | "mesh"
  | "skinnedMesh"
  | "sprite"
  | "tilemap"
  | "camera"
  | "light"
  | "other";

/** 2D engines use `[x, y]`, 3D engines use `[x, y, z]`. Never mixed. */
export type Vec2Or3 = [number, number] | [number, number, number];

export interface GameObjectSummary {
  ref: string;
  /** Recommended persistent selector, e.g. `gameprob:id=main-hero`. */
  selector?: string;
  name: string;
  kind: GameObjectKind;
  engineType: string;
  parentRef?: string;
  visible?: boolean;
  position?: Vec2Or3;
  bounds?: { size: Vec2Or3 };
  childCount?: number;
  animation?: string;
}

export interface SnapshotOptions {
  depth?: number;
  limit?: number;
  delta?: boolean;
}

export interface SnapshotWarning {
  /** Check identifier, e.g. `transform.invalid`. */
  check: string;
  message: string;
  ref?: string;
  /** `high` means the check is mechanical; `low` means it needs human review. */
  confidence?: "high" | "medium" | "low";
}

export interface SnapshotMeta {
  mode: "full" | "delta";
  engine: EngineName | "none";
  sceneName?: string;
  revision: number;
  baseRevision?: number;
  depth: number;
  objectLimit: number;
  objectsShown: number;
  objectsTotal: number;
  truncated: boolean;
}

export interface SnapshotDelta {
  added: GameObjectSummary[];
  updated: GameObjectSummary[];
  removed: string[];
}

export interface SnapshotResult {
  meta: SnapshotMeta;
  objects: GameObjectSummary[];
  delta?: SnapshotDelta;
  warnings: SnapshotWarning[];
}

export interface InspectOptions {
  details?: boolean;
  limit?: number;
}

export interface InspectChildRef {
  ref?: string;
  name: string;
  engineType: string;
}

export interface MaterialSummary {
  name: string;
  type: string;
  colorHex?: string;
  opacity?: number;
  transparent?: boolean;
  side?: number;
  textures: Array<{ slot: string; name: string; imageWidth?: number; imageHeight?: number }>;
}

export interface GeometrySummary {
  type: string;
  vertexCount?: number;
  indexCount?: number;
  attributes?: string[];
  groups?: number;
  bounds?: { min: number[]; max: number[]; size: number[] };
}

export interface SkeletonSummary {
  bones: number;
  rootName?: string;
  boneNames?: string[];
}

export interface RenderStats {
  drawCalls?: number;
  triangles?: number;
  geometries?: number;
  textures?: number;
  programs?: number;
  /** Which frame these counters belong to, when the engine exposes it. */
  frame?: number;
}

export interface InspectResult {
  ref?: string;
  selector?: string;
  name: string;
  kind: GameObjectKind;
  engineType: string;
  uuid?: string;
  visible?: boolean;
  coordinateSpace: "world-3d" | "world-2d" | "unknown";
  localPosition?: number[];
  worldPosition?: number[];
  rotation?: number[];
  scale?: number[];
  parent?: InspectChildRef;
  children?: InspectChildRef[];
  bounds?: { min: number[]; max: number[]; size: number[] };
  geometry?: GeometrySummary;
  materials?: MaterialSummary[];
  skeleton?: SkeletonSummary;
  animations?: string[];
  layers?: number;
  renderStats?: RenderStats;
  capabilities: GameCapabilities;
  warnings: SnapshotWarning[];
  /** Names of fields that were bounded/omitted on purpose. */
  truncated?: string[];
}

export type CapabilityKey =
  | "scene.snapshot"
  | "scene.inspect"
  | "capture.page"
  | "capture.object"
  | "input.keyboard"
  | "input.pointer"
  | "simulation.pause"
  | "simulation.step"
  | "simulation.reset"
  | "simulation.state"
  | "simulation.action"
  | "physics.inspectBody"
  | "physics.contacts"
  | "animations.inspect";

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  "scene.snapshot",
  "scene.inspect",
  "capture.page",
  "capture.object",
  "input.keyboard",
  "input.pointer",
  "simulation.pause",
  "simulation.step",
  "simulation.reset",
  "simulation.state",
  "simulation.action",
  "physics.inspectBody",
  "physics.contacts",
  "animations.inspect",
] as const;

export interface GameCapabilities {
  engine: EngineName | "none";
  bridgeVersion: number | null;
  features: Record<CapabilityKey, boolean>;
  notes: string[];
  /** Where each capability was observed. Never inferred from a dependency. */
  sources?: Record<string, "browser" | "bridge">;
}

export interface OpenResult {
  url: string;
  browser: string;
  bridge: {
    connected: boolean;
    engine?: EngineName;
    bridgeVersion?: number;
  };
  readiness: {
    domReady: boolean;
    /** `unknown` unless the bridge advertises a `ready` capability. */
    gameReady: boolean | "unknown";
  };
  capabilities: GameCapabilities;
  warnings: string[];
}

export type CaptureViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "current";

export interface CaptureOptions {
  page?: boolean;
  selector?: string;
  views?: CaptureViewName[];
  out?: string;
  overwrite?: boolean;
  maxWidth?: number;
  maxHeight?: number;
}

export interface CapturedView {
  view: string;
  /** Written as given by `--out`: project-relative unless the caller passed an absolute path. */
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** False means the renderer produced a uniform frame: never report success blindly. */
  nonBlank: boolean;
  warnings: string[];
}

export interface CaptureResult {
  kind: "page" | "object";
  subject?: { ref?: string; selector?: string; name?: string };
  views: CapturedView[];
  manifestPath?: string;
  warnings: string[];
}

export type GameActionName = "keydown" | "keyup" | "press" | "click" | "step";

export interface ActionResult {
  action: GameActionName;
  detail?: string;
  ticks?: number;
  warnings: string[];
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  missing?: string[];
  hint?: string;
}

export interface ResultEnvelope<T = unknown> {
  protocolVersion: number;
  ok: boolean;
  command: string;
  sessionId?: string;
  data?: T;
  error?: ErrorEnvelope;
  warnings: string[];
  durationMs: number;
}

/** RPC request sent from the short-lived CLI process to the daemon. */
export interface RpcRequest {
  protocolVersion: number;
  requestId: string;
  token: string;
  sessionId?: string;
  command: "open" | "snapshot" | "inspect" | "act" | "capture" | "close" | "ping";
  params: unknown;
}

export interface RpcResponse<T = unknown> {
  protocolVersion: number;
  requestId: string;
  sessionId?: string;
  ok: boolean;
  command: string;
  data?: T;
  error?: ErrorEnvelope;
  warnings: string[];
  durationMs: number;
}
