import { describe, expect, it } from "vitest";
import {
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
} from "../../src/bridge/serialization.ts";

describe("bounded serialization", () => {
  it("never lets NaN or Infinity leak into a projection", () => {
    expect(finiteNumber(Number.NaN)).toBeUndefined();
    expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(finiteNumber("3")).toBeUndefined();
    expect(finiteNumber(3.5)).toBe(3.5);
  });

  it("reads vectors only when every component is finite", () => {
    expect(readVector({ x: 1, y: 2, z: 3 }, 3)).toEqual([1, 2, 3]);
    expect(readVector({ x: 1, y: 2 }, 2)).toEqual([1, 2]);
    expect(readVector({ x: 1, y: Number.NaN, z: 3 }, 3)).toBeUndefined();
    expect(readVector({ x: 1, y: 2 }, 3)).toBeUndefined();
    expect(readEuler({ x: 0, y: 1.23456789, z: 0 })).toEqual([0, 1.234568, 0]);
  });

  it("rounds to a stable number of digits", () => {
    expect(roundNumber(0.1 + 0.2)).toBe(0.3);
    expect(roundNumber(1.23456789, 4)).toBe(1.2346);
  });

  it("bounds long lists and reports the truncation", () => {
    const bounded = boundArray([1, 2, 3, 4], 2);
    expect(bounded.items).toEqual([1, 2]);
    expect(bounded.truncated).toBe(true);
    expect(boundArray([1], 2)).toEqual({ items: [1], truncated: false });
  });

  it("bounds and clips strings", () => {
    expect(safeString("  hero  ")).toBe("hero");
    expect(safeString("")).toBeUndefined();
    expect(safeString(42)).toBeUndefined();
    expect(safeString("abcdef", 3)).toBe("abc…");
  });

  it("formats colors as hex or omits them", () => {
    expect(colorToHex(0xff8800)).toBe("#ff8800");
    expect(colorToHex(-1)).toBeUndefined();
    expect(colorToHex("red")).toBeUndefined();
  });

  it("reports invalid bounds instead of returning infinities", () => {
    const bounds = emptyBounds();
    expect(boundsAreValid(bounds)).toBe(false);
    expandBounds(bounds, [1, 2, 3]);
    expandBounds(bounds, [-1, 0, 5]);
    expect(boundsAreValid(bounds)).toBe(true);
    expect(bounds).toEqual({ min: [-1, 0, 3], max: [1, 2, 5] });
  });
});
