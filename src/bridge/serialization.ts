/**
 * Bounded, safe projections of live engine objects.
 *
 * Nothing here ever returns a live engine object: only plain JSON values with
 * finite numbers and bounded strings. Special numbers (`NaN`, `Infinity`) are
 * reported through warnings rather than silently serialized.
 */

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function roundNumber(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isFiniteVector(components: Array<number | undefined>): boolean {
  return (
    components.length > 0 && components.every((c) => typeof c === "number" && Number.isFinite(c))
  );
}

/** Reads `{x,y}` / `{x,y,z}` into a plain array, dropping non-finite values. */
export function readVector(value: unknown, dimensions: 2 | 3, round = true): number[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as { x?: unknown; y?: unknown; z?: unknown };
  const raw = [source.x, source.y, dimensions === 3 ? source.z : undefined];
  const components = raw
    .slice(0, dimensions)
    .map((c) => finiteNumber(c))
    .filter((c): c is number => c !== undefined);
  if (components.length !== dimensions) return undefined;
  return round ? components.map((c) => roundNumber(c)) : components;
}

export function readEuler(value: unknown): number[] | undefined {
  return readVector(value, 3);
}

export function safeString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

export function colorToHex(value: unknown): string | undefined {
  const num = finiteNumber(value);
  if (num === undefined || num < 0) return undefined;
  return `#${Math.round(num).toString(16).padStart(6, "0").slice(-6)}`;
}

export function boundArray<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  if (items.length <= limit) return { items, truncated: false };
  return { items: items.slice(0, limit), truncated: true };
}

/** Column-major 4x4 matrix point transform (Three.js `Matrix4.elements`). */
export function applyMatrix4ToPoint(
  elements: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const e = elements;
  const w = (e[3] ?? 0) * x + (e[7] ?? 0) * y + (e[11] ?? 0) * z + (e[15] ?? 1);
  const invW = w !== 0 ? 1 / w : 1;
  return [
    ((e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0)) * invW,
    ((e[1] ?? 0) * x + (e[5] ?? 0) * y + (e[9] ?? 0) * z + (e[13] ?? 0)) * invW,
    ((e[2] ?? 0) * x + (e[6] ?? 0) * y + (e[10] ?? 0) * z + (e[14] ?? 0)) * invW,
  ];
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export function emptyBounds(): Bounds3 {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

export function expandBounds(bounds: Bounds3, point: [number, number, number]): void {
  for (let i = 0; i < 3; i += 1) {
    const value = point[i] as number;
    if (value < (bounds.min[i] as number)) bounds.min[i] = value;
    if (value > (bounds.max[i] as number)) bounds.max[i] = value;
  }
}

export function boundsAreValid(bounds: Bounds3): boolean {
  return bounds.min.every((v) => Number.isFinite(v)) && bounds.max.every((v) => Number.isFinite(v));
}
