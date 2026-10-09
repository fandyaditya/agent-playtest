/**
 * Structural, version-tolerant view of Three.js objects.
 *
 * Deliberately NOT `import type * as THREE from "three"`: the bridge must not
 * drag another copy of Three.js into the consumer's bundle, and the adapter must
 * survive Three.js API drift. Only the fields we actually read are declared.
 */

export interface V3 {
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

export interface Matrix4Like {
  elements?: ArrayLike<number>;
}

export interface BufferAttributeLike {
  count?: number;
  itemSize?: number;
  name?: string;
}

export interface GeometryLike {
  type?: string;
  uuid?: string;
  attributes?: Record<string, BufferAttributeLike | undefined>;
  index?: { count?: number } | null;
  groups?: unknown[];
  boundingBox?: { min?: V3; max?: V3 } | null;
  computeBoundingBox?: () => void;
  isBufferGeometry?: boolean;
}

export interface TextureLike {
  name?: string;
  image?: { width?: number; height?: number } | null;
}

export interface MaterialLike {
  type?: string;
  name?: string;
  uuid?: string;
  color?: { getHex?: () => number } | null;
  opacity?: number;
  transparent?: boolean;
  visible?: boolean;
  side?: number;
  map?: TextureLike | null;
  normalMap?: TextureLike | null;
  roughnessMap?: TextureLike | null;
  metalnessMap?: TextureLike | null;
  emissiveMap?: TextureLike | null;
  alphaMap?: TextureLike | null;
  aoMap?: TextureLike | null;
}

export interface SkeletonLike {
  bones?: unknown[];
}

export interface Object3DLike {
  type?: string;
  name?: string;
  uuid?: string;
  id?: number;
  visible?: boolean;
  layers?: { mask?: number };
  castShadow?: boolean;
  receiveShadow?: boolean;
  children?: Object3DLike[];
  parent?: Object3DLike | null;
  position?: V3;
  rotation?: V3;
  quaternion?: V3 & { w?: unknown };
  scale?: V3;
  matrixWorld?: Matrix4Like;
  userData?: Record<string, unknown>;
  geometry?: GeometryLike | null;
  material?: MaterialLike | MaterialLike[] | null;
  skeleton?: SkeletonLike;
  animations?: unknown[];
  isScene?: boolean;
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
  isSprite?: boolean;
  isCamera?: boolean;
  isLight?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isGroup?: boolean;
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
  updateMatrixWorld?: (force?: boolean) => void;
}

export interface RendererInfoLike {
  render?: { calls?: number; triangles?: number; frame?: number; points?: number; lines?: number };
  memory?: { geometries?: number; textures?: number };
  programs?: unknown[] | null;
}

export interface WebGLRendererLike {
  domElement?: { width?: number; height?: number };
  info?: RendererInfoLike;
  render?: (scene: unknown, camera: unknown) => void;
  getContext?: () => unknown;
}

export interface CameraLike extends Object3DLike {
  fov?: number;
  near?: number;
  far?: number;
  aspect?: number;
  isPerspectiveCamera?: boolean;
  isOrthographicCamera?: boolean;
  clone?: () => CameraLike;
  lookAt?: (x: number, y: number, z: number) => void;
  updateProjectionMatrix?: () => void;
  updateMatrixWorld?: (force?: boolean) => void;
}

export function readAgentPlaytestMeta(object: Object3DLike): {
  id?: string;
  role?: string;
  animation?: string;
} {
  const userData = object.userData;
  if (!userData || typeof userData !== "object") return {};
  // Game code opts in by marking objects: `node.userData.agentPlaytest = { id, role }`.
  const raw = (userData as Record<string, unknown>).agentPlaytest;
  if (!raw || typeof raw !== "object") return {};
  const meta = raw as Record<string, unknown>;
  const result: { id?: string; role?: string; animation?: string } = {};
  if (typeof meta.id === "string" && meta.id.length > 0) result.id = meta.id;
  if (typeof meta.role === "string" && meta.role.length > 0) result.role = meta.role;
  if (typeof meta.animation === "string" && meta.animation.length > 0)
    result.animation = meta.animation;
  return result;
}

/** Helper objects are intentionally non-renderable; never report them as defects. */
export function looksLikeHelper(object: Object3DLike): boolean {
  const type = object.type ?? "";
  const name = object.name ?? "";
  return (
    /Helper$/.test(type) || /Helper$/.test(name) || type === "GridHelper" || type === "AxesHelper"
  );
}
