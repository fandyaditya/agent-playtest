import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readPngInfo,
  resolveWriteTarget,
  slugify,
  timestampId,
  writePng,
} from "../../src/browser/capture.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-playtest-capture-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function png(width: number, height: number, padding = 0): Buffer {
  const buffer = Buffer.alloc(24 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("PNG verification", () => {
  it("reads the real dimensions instead of trusting the request", () => {
    expect(readPngInfo(png(960, 540))).toEqual({ width: 960, height: 540, bytes: 24 });
  });

  it("rejects non-PNG bytes, truncated headers and zero-sized images", () => {
    expect(readPngInfo(Buffer.from("definitely not a png"))).toBeNull();
    expect(readPngInfo(png(960, 540).subarray(0, 20))).toBeNull();
    expect(readPngInfo(png(0, 540))).toBeNull();
  });

  it("refuses to write anything it could not verify", () => {
    const target = resolveWriteTarget(root, "output/bad.png", false);
    expect(() => writePng(target, Buffer.from("nope"))).toThrowError(/not a valid PNG/);
  });

  it("writes a verified PNG and reports its size", () => {
    const target = resolveWriteTarget(root, "output/page.png", false);
    const info = writePng(target, png(320, 200));

    expect(info).toEqual({ width: 320, height: 200, bytes: 24 });
    expect(readFileSync(target.path).length).toBe(24);
  });
});

describe("capture output paths", () => {
  it("resolves an explicit file inside the project", () => {
    const target = resolveWriteTarget(root, ".agent-playtest/output/page.png", false);
    expect(target.path).toBe(join(root, ".agent-playtest/output/page.png"));
    expect(target.relative).toBe(".agent-playtest/output/page.png");
  });

  it("normalizes an absolute path to a project-relative one", () => {
    const target = resolveWriteTarget(
      root,
      resolve(root, ".agent-playtest/output/page.png"),
      false,
    );
    expect(target.relative).toBe(".agent-playtest/output/page.png");
  });

  it("refuses to write outside the project", () => {
    expect(() => resolveWriteTarget(root, "../escape.png", false)).toThrowError(
      /outside the project/,
    );
  });

  it("refuses to overwrite an existing file without permission", () => {
    const file = join(root, "output", "page.png");
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(file, png(1, 1));

    expect(() => resolveWriteTarget(root, "output/page.png", false)).toThrowError(
      /Refusing to overwrite/,
    );
    expect(resolveWriteTarget(root, "output/page.png", true).path).toBe(file);
  });
});

describe("generated names", () => {
  it("never returns an empty or unsafe slug", () => {
    expect(slugify("agent-playtest:id=main-hero")).toBe("agent-playtest-id-main-hero");
    expect(slugify("   ")).toBe("capture");
    expect(slugify("../../etc/passwd")).not.toContain("..");
  });

  it("produces sortable, collision-resistant run ids", () => {
    const first = timestampId(new Date("2026-01-02T03:04:05.006Z"));
    const second = timestampId(new Date("2026-01-02T03:04:05.007Z"));
    expect(first).toMatch(/^\d{8}-\d{6}-\d{3}$/);
    expect(first).not.toBe(second);
  });
});
