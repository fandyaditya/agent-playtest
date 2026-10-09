/**
 * The shared browser-game driver.
 *
 * The interactive daemon and the `gameprob/test` fixture both drive a page
 * through THIS class, so CLI inspection and saved tests cannot drift apart.
 */

import { join, relative } from "node:path";
import type { Page } from "playwright";
import type { BeginCaptureResult } from "../bridge/capture.ts";
import { capabilityError, GameProbError } from "../shared/errors.ts";
import { atomicWriteJson } from "../shared/paths.ts";
import type { ResolvedConfig } from "../shared/schemas.ts";
import type {
  ActionResult,
  CapabilityKey,
  CapturedView,
  CaptureOptions,
  CaptureResult,
  CaptureViewName,
  GameCapabilities,
  InspectOptions,
  InspectResult,
  OpenResult,
  SnapshotOptions,
  SnapshotResult,
} from "../shared/types.ts";
import { type BridgeProbe, invokeBridge, probeBridge, waitForBridge } from "./bridge-client.ts";
import {
  readPngInfo,
  resolveWriteTarget,
  screenshotCanvas,
  screenshotPage,
  slugify,
  timestampId,
  writePng,
} from "./capture.ts";
import { clickAt, type KeyAction, keyAction } from "./input.ts";

export interface ConsoleEntry {
  type: string;
  text: string;
  at: string;
}

export interface DriverOptions {
  projectRoot: string;
  config: ResolvedConfig;
  page: Page;
  /** Absolute directory where generated evidence is written. */
  outputRoot: string;
  browserLabel?: string;
  bridgeWaitMs?: number;
  navigationTimeoutMs?: number;
}

export interface ActRequest {
  action: "keydown" | "keyup" | "press" | "click" | "step";
  key?: string;
  x?: number;
  y?: number;
  ticks?: number;
}

const MAX_CONSOLE_ENTRIES = 200;
const DEFAULT_VIEWS: CaptureViewName[] = ["front"];

export class BrowserGameDriver {
  readonly page: Page;
  readonly projectRoot: string;
  readonly config: ResolvedConfig;
  readonly outputRoot: string;

  #browserLabel: string;
  #bridgeWaitMs: number;
  #navigationTimeoutMs: number;
  #probe: BridgeProbe | null = null;
  #opened = false;
  #console: ConsoleEntry[] = [];
  #knownRefs = new Set<string>();
  #listeners: Array<() => void> = [];

  constructor(options: DriverOptions) {
    this.page = options.page;
    this.projectRoot = options.projectRoot;
    this.config = options.config;
    this.outputRoot = options.outputRoot;
    this.#browserLabel = options.browserLabel ?? "Chromium";
    this.#bridgeWaitMs = options.bridgeWaitMs ?? 4000;
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.#attachTracking();
  }

  #attachTracking(): void {
    const onConsole = (message: { type(): string; text(): string }) => {
      if (!["error", "warning"].includes(message.type())) return;
      this.#pushConsole(message.type(), message.text());
    };
    const onPageError = (error: Error) => {
      this.#pushConsole("pageerror", error.message);
    };
    const onCrash = () => {
      this.#pushConsole("pageerror", "The page crashed; object refs for this session are invalid.");
      this.#probe = null;
      this.#opened = false;
    };
    this.page.on("console", onConsole);
    this.page.on("pageerror", onPageError);
    this.page.on("crash", onCrash);
    this.#listeners.push(
      () => this.page.off("console", onConsole),
      () => this.page.off("pageerror", onPageError),
      () => this.page.off("crash", onCrash),
    );
  }

  #pushConsole(type: string, text: string): void {
    this.#console.push({ type, text: text.slice(0, 2000), at: new Date().toISOString() });
    if (this.#console.length > MAX_CONSOLE_ENTRIES) this.#console.shift();
  }

  consoleEntries(): ConsoleEntry[] {
    return [...this.#console];
  }

  consoleErrors(): ConsoleEntry[] {
    return this.#console.filter((entry) => entry.type === "error" || entry.type === "pageerror");
  }

  get bridgeConnected(): boolean {
    return this.#probe !== null;
  }

  async open(urlArgument?: string, options: { allowRemote?: boolean } = {}): Promise<OpenResult> {
    const raw = urlArgument ?? this.config.game.url;
    if (!raw) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: "No URL was provided and .gameprob/config.json has no game.url.",
        hint: "Run: gameprob open http://127.0.0.1:5173/?gameprob=1",
      });
    }
    const target = assertAllowedTarget(raw, options.allowRemote === true);

    const warnings: string[] = [];
    const reuse = this.#opened && this.page.url() === target;
    if (!reuse) {
      if (this.#opened) {
        warnings.push(
          "Navigated to a new URL; previous object refs and snapshot deltas were invalidated.",
        );
      }
      try {
        await this.page.goto(target, {
          waitUntil: "domcontentloaded",
          timeout: this.#navigationTimeoutMs,
        });
      } catch (error) {
        this.#opened = false;
        this.#probe = null;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        throw new GameProbError({
          code: "NAVIGATION_FAILED",
          message: `Navigation to ${target} failed: ${message}`,
          hint: "Confirm the development server is running and the URL is correct. GameProb does not start your dev server.",
          cause: error,
        });
      }
      this.#opened = true;
      this.#probe = null;
    }

    this.#probe = await waitForBridge(this.page, this.#bridgeWaitMs);
    const bridge = this.#probe;
    if (bridge && bridge.version !== 1) {
      warnings.push(
        `The page registered bridge version ${bridge.version}, but this CLI speaks version 1. Reinstall so the bridge and CLI come from one package version.`,
      );
      this.#probe = null;
    }

    let gameReady: boolean | "unknown" = "unknown";
    if (this.#probe) {
      try {
        const ready = await invokeBridge<boolean | null>(this.page, "ready", []);
        if (typeof ready === "boolean") gameReady = ready;
      } catch {
        gameReady = "unknown";
      }
    } else {
      warnings.push("No GameProb bridge was detected on this page: running in browser-only mode.");
      warnings.push(
        "Scene snapshots require the development-only bridge. Run `gameprob init` and connect .gameprob/bridge.ts.",
      );
    }

    const capabilities = await this.capabilities();
    warnings.push(...capabilities.notes);

    return {
      url: target,
      browser: this.#browserLabel,
      bridge: this.#probe
        ? { connected: true, engine: this.#probe.engine, bridgeVersion: this.#probe.version }
        : { connected: false },
      readiness: { domReady: true, gameReady },
      capabilities,
      warnings,
    };
  }

  async capabilities(): Promise<GameCapabilities> {
    const features = emptyFeatures();
    const sources: Record<string, "browser" | "bridge"> = {};
    for (const key of ["capture.page", "input.keyboard", "input.pointer"] as CapabilityKey[]) {
      features[key] = true;
      sources[key] = "browser";
    }

    if (!this.#probe) {
      this.#probe = await probeBridge(this.page);
    }

    if (!this.#probe) {
      return {
        engine: "none",
        bridgeVersion: null,
        features,
        notes: [
          "Browser-only mode: no game bridge is connected, so scene objects cannot be inspected.",
        ],
        sources,
      };
    }

    const bridgeCaps = await invokeBridge<GameCapabilities>(this.page, "capabilities", []);
    for (const [key, value] of Object.entries(bridgeCaps.features ?? {})) {
      if (value === true) {
        features[key as CapabilityKey] = true;
        sources[key] = "bridge";
      }
    }
    return {
      engine: bridgeCaps.engine,
      bridgeVersion: bridgeCaps.bridgeVersion,
      features,
      notes: bridgeCaps.notes ?? [],
      sources,
    };
  }

  async snapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    if (!this.#probe && !(await this.#refreshProbe())) {
      throw new GameProbError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "GameProb cannot produce a game-scene snapshot without a connected bridge.",
        missing: ["scene.snapshot", "bridge"],
        hint: "Run `gameprob init`, connect .gameprob/bridge.ts in development, and load the page with ?gameprob=1. `capture --page` works without a bridge.",
      });
    }
    const result = await invokeBridge<SnapshotResult>(this.page, "snapshot", [options]);
    for (const object of result.objects) this.#knownRefs.add(object.ref);
    if (result.delta) {
      for (const summary of [...result.delta.added, ...result.delta.updated]) {
        this.#knownRefs.add(summary.ref);
      }
    }
    return result;
  }

  async inspect(selector: string, options: InspectOptions = {}): Promise<InspectResult> {
    await this.#assertBridge("inspect");
    try {
      const result = await invokeBridge<InspectResult>(this.page, "inspect", [selector, options]);
      if (result.ref) this.#knownRefs.add(result.ref);
      return result;
    } catch (error) {
      const trimmed = selector.trim();
      if (
        error instanceof GameProbError &&
        error.code === "OBJECT_NOT_FOUND" &&
        this.#knownRefs.has(trimmed)
      ) {
        throw new GameProbError({
          code: "STALE_REF",
          message: `Ref ${trimmed} belonged to an earlier scene generation and no longer resolves.`,
          hint: "Run `gameprob snapshot` again for fresh refs. Saved tests should use a persistent selector such as gameprob:id=<id>.",
        });
      }
      throw error;
    }
  }

  async act(request: ActRequest): Promise<ActionResult> {
    switch (request.action) {
      case "keydown":
      case "keyup":
      case "press": {
        if (request.key === undefined) {
          throw new GameProbError({
            code: "INVALID_ARGUMENT",
            message: `act ${request.action} requires a key.`,
            hint: `Example: gameprob act ${request.action} ArrowRight`,
          });
        }
        const key = await keyAction(this.page, request.action as KeyAction, request.key);
        return { action: request.action, detail: key, warnings: [] };
      }
      case "click": {
        if (request.x === undefined || request.y === undefined) {
          throw new GameProbError({
            code: "INVALID_ARGUMENT",
            message: "act click requires x and y viewport CSS pixel coordinates.",
            hint: "Example: gameprob act click 400 280",
          });
        }
        const where = await clickAt(this.page, request.x, request.y);
        return { action: "click", detail: where, warnings: [] };
      }
      case "step": {
        const ticks = request.ticks;
        if (ticks === undefined || !Number.isInteger(ticks) || ticks < 1) {
          throw new GameProbError({
            code: "INVALID_ARGUMENT",
            message: "act step requires a positive integer tick count.",
            hint: "Example: gameprob act step 120",
          });
        }
        const result = await this.step(ticks);
        return { action: "step", ticks: result.ticks, warnings: result.warnings };
      }
    }
  }

  /**
   * Tier C operations. Each one checks the observed capability map first and
   * fails with the missing hook names instead of pretending to have run.
   */
  async step(ticks: number, dtSeconds?: number): Promise<{ ticks: number; warnings: string[] }> {
    await this.#requireCapabilities(
      ["simulation.pause", "simulation.step"],
      "Controlled simulation is not connected for this project.",
      "Add the optional simulation hooks (pause/step) in .gameprob/bridge.ts.",
    );
    return invokeBridge<{ ticks: number; warnings: string[] }>(
      this.page,
      "simulation.step",
      dtSeconds === undefined ? [ticks] : [ticks, dtSeconds],
    );
  }

  async reset(fixture?: string): Promise<void> {
    await this.#requireCapabilities(
      ["simulation.reset"],
      "Deterministic reset is not connected for this project.",
      "Add simulation.reset in .gameprob/bridge.ts so tests can start from a known state.",
    );
    await invokeBridge<void>(this.page, "simulation.reset", fixture === undefined ? [] : [fixture]);
  }

  async state(subject?: string): Promise<unknown> {
    await this.#requireCapabilities(
      ["simulation.state"],
      "Gameplay state readback is not connected for this project.",
      "Add simulation.state in .gameprob/bridge.ts to assert on real gameplay values.",
    );
    return invokeBridge<unknown>(
      this.page,
      "simulation.state",
      subject === undefined ? [] : [subject],
    );
  }

  async action(name: string, args: unknown = {}): Promise<void> {
    await this.#requireCapabilities(
      ["simulation.action"],
      "Scripted game actions are not connected for this project.",
      "Add simulation.action in .gameprob/bridge.ts.",
    );
    await invokeBridge<void>(this.page, "simulation.action", [name, args]);
  }

  async inspectBody(subject: string): Promise<unknown> {
    await this.#requireCapabilities(
      ["physics.inspectBody"],
      "Physics body inspection is not connected for this project.",
      "Add physics.inspectBody in .gameprob/bridge.ts.",
    );
    return invokeBridge<unknown>(this.page, "physics.inspectBody", [subject]);
  }

  async contacts(subject: string): Promise<unknown> {
    await this.#requireCapabilities(
      ["physics.contacts"],
      "Physics contact inspection is not connected for this project.",
      "Add physics.contacts in .gameprob/bridge.ts. Bounding-box overlap is not a substitute for real contact data.",
    );
    return invokeBridge<unknown>(this.page, "physics.contacts", [subject]);
  }

  async #requireCapabilities(keys: CapabilityKey[], message: string, hint: string): Promise<void> {
    const capabilities = await this.capabilities();
    const missing = keys.filter((key) => !capabilities.features[key]);
    if (missing.length > 0) throw capabilityError(message, missing, hint);
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    if (options.page === true || !options.selector) return this.#capturePage(options);
    return this.#captureObject(options);
  }

  async #capturePage(options: CaptureOptions): Promise<CaptureResult> {
    const buffer = await screenshotPage(this.page);
    const info = readPngInfo(buffer);
    if (!info) {
      throw new GameProbError({
        code: "INTERNAL_ERROR",
        message: "Playwright returned a page screenshot that is not a valid PNG.",
      });
    }
    const single = resolveSingleFile(options.out, ".png");
    const overwrite = options.overwrite === true;
    const target = single
      ? resolveWriteTarget(this.projectRoot, single, overwrite)
      : resolveWriteTarget(
          this.projectRoot,
          join(relative(this.projectRoot, this.outputRoot), `page-${timestampId()}.png`),
          overwrite,
        );
    writePng(target, buffer);
    const view: CapturedView = {
      view: "page",
      path: target.relative,
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      nonBlank: true,
      warnings: [],
    };
    const manifestPath = this.#writeManifest("page", [view], {}, []);
    return { kind: "page", views: [view], manifestPath, warnings: [] };
  }

  async #captureObject(options: CaptureOptions): Promise<CaptureResult> {
    const selector = options.selector as string;
    await this.#assertBridge("capture");
    const capabilities = await this.capabilities();
    if (!capabilities.features["capture.object"]) {
      throw capabilityError(
        "Object capture is not available for this project.",
        ["capture.object"],
        "Use `capture --page`, or connect scene/camera/renderer in .gameprob/bridge.ts.",
      );
    }

    const inspected = await this.inspect(selector, {});
    const views = options.views && options.views.length > 0 ? options.views : DEFAULT_VIEWS;
    const warnings: string[] = [];

    const single = views.length === 1 ? resolveSingleFile(options.out, ".png") : null;
    const directory = single
      ? null
      : resolveInsideDirectory(
          this.projectRoot,
          options.out ??
            join(relative(this.projectRoot, this.outputRoot), `capture-${timestampId()}`),
        );
    const slug = slugify(inspected.selector ?? inspected.name, "object");

    const captured: CapturedView[] = [];
    for (const view of views) {
      const begin = await invokeBridge<BeginCaptureResult>(this.page, "beginCapture", [
        { selector, view },
      ]);
      try {
        if (begin.frame && begin.frame.nonBlank === false) {
          throw new GameProbError({
            code: "CAPABILITY_UNAVAILABLE",
            message: `The renderer produced a uniform (blank) frame for view "${view}" of ${begin.subject.name}.`,
            missing: ["capture.object"],
            hint: "The subject may be outside the render area or not yet rendered. Check its bounds and visibility with `inspect --details`.",
          });
        }
        const buffer = await screenshotCanvas(this.page);
        const info = readPngInfo(buffer);
        if (!info) {
          throw new GameProbError({
            code: "INTERNAL_ERROR",
            message: "The canvas screenshot is not a valid PNG.",
          });
        }
        const target = resolveWriteTarget(
          this.projectRoot,
          single ?? join(directory as string, `${slug}-${view}.png`),
          options.overwrite === true,
        );
        writePng(target, buffer);
        const viewWarnings = [...begin.warnings];
        if (!begin.frame) {
          viewWarnings.push("Blankness could not be verified from the WebGL framebuffer.");
        }
        captured.push({
          view,
          path: target.relative,
          width: info.width,
          height: info.height,
          bytes: info.bytes,
          nonBlank: begin.frame ? begin.frame.nonBlank : true,
          warnings: viewWarnings,
        });
        warnings.push(...viewWarnings);
      } finally {
        try {
          await invokeBridge<{ warnings: string[] }>(this.page, "endCapture", [begin.token]);
        } catch {
          warnings.push(`The capture window for view "${view}" did not close cleanly.`);
        }
      }
    }

    const manifestPath = this.#writeManifest(
      "object",
      captured,
      {
        name: inspected.name,
        ...(inspected.selector ? { selector: inspected.selector } : {}),
        ...(inspected.worldPosition ? { worldPosition: inspected.worldPosition } : {}),
      },
      warnings,
    );

    return {
      kind: "object",
      subject: {
        ...(inspected.ref ? { ref: inspected.ref } : {}),
        ...(inspected.selector ? { selector: inspected.selector } : {}),
        name: inspected.name,
      },
      views: captured,
      ...(manifestPath ? { manifestPath } : {}),
      warnings,
    };
  }

  #writeManifest(
    kind: "page" | "object",
    views: CapturedView[],
    subject: Record<string, unknown>,
    warnings: string[],
  ): string | undefined {
    if (views.length === 0) return undefined;
    const first = views[0] as CapturedView;
    const directory = first.path.includes("/")
      ? first.path.slice(0, first.path.lastIndexOf("/"))
      : ".";
    const manifestRelative = `${directory}/manifest-${timestampId()}.json`;
    const manifestAbsolute = join(this.projectRoot, manifestRelative);
    atomicWriteJson(manifestAbsolute, {
      kind,
      generatedAt: new Date().toISOString(),
      project: this.config.project.name,
      browser: this.#browserLabel,
      viewport: this.config.browser.viewport,
      deviceScaleFactor: this.config.browser.deviceScaleFactor,
      subject,
      views,
      warnings,
    });
    return manifestRelative;
  }

  async #refreshProbe(): Promise<boolean> {
    this.#probe = await probeBridge(this.page);
    return this.#probe !== null;
  }

  async #assertBridge(what: string): Promise<void> {
    if (this.#probe) return;
    if (await this.#refreshProbe()) return;
    throw new GameProbError({
      code: "BRIDGE_NOT_CONNECTED",
      message: `\`${what}\` requires the development-only GameProb bridge, which is not connected on this page.`,
      missing: ["bridge"],
      hint: "Run `gameprob init`, connect .gameprob/bridge.ts during development, and reload with ?gameprob=1.",
    });
  }

  dispose(): void {
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }
}

export function assertAllowedTarget(rawUrl: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Not a valid URL: ${rawUrl}`,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GameProbError({
      code: "UNAUTHORIZED_TARGET",
      message: `Only http(s) targets are allowed (received ${url.protocol}).`,
    });
  }
  if (allowRemote) return url.toString();

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new GameProbError({
      code: "UNAUTHORIZED_TARGET",
      message: `Refusing to navigate to non-loopback origin ${url.origin}.`,
      hint: "GameProb is local-first. Pass --allow-remote to explicitly opt in to a remote target.",
    });
  }
  return url.toString();
}

export function outputRootFor(projectRoot: string, config: ResolvedConfig): string {
  return join(projectRoot, config.output.directory);
}

function resolveSingleFile(out: string | undefined, extension: string): string | null {
  if (!out) return null;
  return out.toLowerCase().endsWith(extension) ? out : null;
}

function resolveInsideDirectory(projectRoot: string, candidate: string): string {
  const target = join(projectRoot, candidate);
  const rel = relative(projectRoot, target);
  if (rel.startsWith("..")) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Refusing to write outside the project: ${candidate}`,
    });
  }
  return target;
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
