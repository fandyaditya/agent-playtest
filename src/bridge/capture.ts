/**
 * In-page object capture.
 *
 * Uses a *cloned* inspection camera and a temporarily wrapped
 * `renderer.render`, so the game's own camera, scene and materials are never
 * mutated. Every capture window is closed by `endCapture` in a `finally`.
 */

import { capabilityError, GameProbError } from "../shared/errors.ts";
import type { CaptureViewName } from "../shared/types.ts";
import type { ThreeAdapter } from "./adapters/three.ts";
import type { CameraLike, Object3DLike, WebGLRendererLike } from "./adapters/three-types.ts";
import { roundNumber } from "./serialization.ts";

export interface FrameStats {
  width: number;
  height: number;
  sampledPixels: number;
  meanLuma: number;
  distinctColors: number;
  nonBlank: boolean;
}

export interface BeginCaptureResult {
  token: string;
  view: CaptureViewName;
  subject: { name: string; selector?: string };
  /** `null` when the WebGL framebuffer could not be read back. */
  frame: FrameStats | null;
  warnings: string[];
}

export interface CaptureHost {
  adapter: ThreeAdapter;
  scene: Object3DLike;
  camera: CameraLike;
  renderer: WebGLRendererLike;
}

interface ActiveCapture {
  renderer: WebGLRendererLike;
  originalRender: WebGLRendererLike["render"];
  close: () => void;
}

const active = new Map<string, ActiveCapture>();
let counter = 0;

export function beginCapture(
  host: CaptureHost,
  object: Object3DLike,
  view: CaptureViewName,
): BeginCaptureResult {
  const { adapter, scene, camera, renderer } = host;
  if (!adapter.supportsObjectCapture()) {
    throw capabilityError(
      "Object capture requires a controllable camera and renderer.",
      ["capture.object"],
      "Pass `scene`, `camera` and `renderer` to connect(); use `capture --page` meanwhile.",
    );
  }

  const warnings: string[] = [];
  const plan = view === "current" ? null : adapter.viewPlan(object, view);
  if (view !== "current" && !plan) {
    throw new GameProbError({
      code: "CAPABILITY_UNAVAILABLE",
      message: `Cannot compute framing for view "${view}": the subject has no measurable geometry bounds.`,
      missing: ["geometry.bounds"],
      hint: "Confirm the subject has visible geometry, or capture the page instead.",
    });
  }

  let inspectionCamera: CameraLike | null = null;
  if (plan) {
    if (typeof camera.clone !== "function") {
      warnings.push(
        "The camera could not be cloned; the capture may not be framed on the subject.",
      );
    } else {
      const clone = camera.clone();
      if (clone.position) {
        clone.position.x = plan.eye[0];
        clone.position.y = plan.eye[1];
        clone.position.z = plan.eye[2];
      }
      clone.lookAt?.(plan.target[0], plan.target[1], plan.target[2]);
      if (plan.fov !== undefined && typeof clone.fov === "number") {
        clone.fov = plan.fov;
        clone.updateProjectionMatrix?.();
      }
      clone.updateMatrixWorld?.(true);
      inspectionCamera = clone;
    }
  }

  const originalRender = renderer.render;
  if (inspectionCamera && typeof originalRender === "function") {
    const bound = originalRender.bind(renderer);
    renderer.render = ((targetScene: unknown) =>
      bound(targetScene, inspectionCamera)) as WebGLRendererLike["render"];
    try {
      bound(scene, inspectionCamera);
    } catch (error) {
      renderer.render = originalRender;
      throw new GameProbError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `The renderer rejected an inspection render: ${error instanceof Error ? error.message : String(error)}`,
        missing: ["capture.object"],
      });
    }
  } else if (inspectionCamera) {
    warnings.push("renderer.render is unavailable; the captured frame may show the game camera.");
  }

  const frame = sampleFramebuffer(renderer);
  if (!frame) {
    warnings.push(
      "Could not read back the WebGL framebuffer, so an all-blank frame could not be ruled out automatically.",
    );
  }

  counter += 1;
  const token = `cap_${counter}`;
  active.set(token, {
    renderer,
    originalRender,
    close: () => {
      renderer.render = originalRender;
      if (typeof originalRender === "function") {
        try {
          originalRender.call(renderer, scene, camera);
        } catch {
          // Restoring the frame is best effort; the game loop will redraw.
        }
      }
    },
  });

  const id = adapter.persistentIdOf(object);
  return {
    token,
    view,
    subject: { name: adapter.nameOf(object), ...(id ? { selector: `gameprob:id=${id}` } : {}) },
    frame,
    warnings,
  };
}

export function endCapture(token: string): { warnings: string[] } {
  const entry = active.get(token);
  if (!entry) {
    return { warnings: [`Capture window ${token} was already closed.`] };
  }
  active.delete(token);
  entry.close();
  return { warnings: [] };
}

export function endAllCaptures(): void {
  for (const [token, entry] of active) {
    active.delete(token);
    entry.close();
  }
}

function sampleFramebuffer(renderer: WebGLRendererLike): FrameStats | null {
  const gl = renderer.getContext?.() as
    | {
        readPixels?: (
          x: number,
          y: number,
          width: number,
          height: number,
          format: number,
          type: number,
          pixels: Uint8Array,
        ) => void;
        RGBA?: number;
        UNSIGNED_BYTE?: number;
      }
    | null
    | undefined;
  const canvas = renderer.domElement;
  const width = Math.floor(Number(canvas?.width ?? 0));
  const height = Math.floor(Number(canvas?.height ?? 0));
  if (!gl?.readPixels || width <= 0 || height <= 0) return null;

  const RGBA = gl.RGBA ?? 0x1908;
  const UNSIGNED_BYTE = gl.UNSIGNED_BYTE ?? 0x1401;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
  const row = new Uint8Array(width * 4);
  const colors = new Set<number>();
  let sampled = 0;
  let lumaSum = 0;

  for (let y = 0; y < height; y += step) {
    try {
      gl.readPixels(0, y, width, 1, RGBA, UNSIGNED_BYTE, row);
    } catch {
      return null;
    }
    for (let x = 0; x < width; x += step) {
      const index = x * 4;
      const r = row[index] ?? 0;
      const g = row[index + 1] ?? 0;
      const b = row[index + 2] ?? 0;
      lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      sampled += 1;
    }
  }

  if (sampled === 0) return null;
  return {
    width,
    height,
    sampledPixels: sampled,
    meanLuma: roundNumber(lumaSum / sampled, 3),
    distinctColors: colors.size,
    nonBlank: colors.size > 1,
  };
}
