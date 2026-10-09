/**
 * Zod boundary validation for on-disk config and IPC messages.
 *
 * Every value that crosses a trust boundary (project config file, user config,
 * daemon RPC) is parsed here before it is used.
 */

import { z } from "zod";
import { CONFIG_SCHEMA_VERSION, PROTOCOL_VERSION } from "./types.ts";

export const engineHintSchema = z.enum(["three", "phaser", "pixi", "unknown"]);

/**
 * Shape of `.agent-playtest/config.json`. All fields are optional on disk; defaults
 * and precedence live in `resolveConfig` so behavior is explicit and testable.
 */
export const projectConfigSchema = z.strictObject({
  schemaVersion: z.number().int().optional(),
  project: z
    .strictObject({
      name: z.string().min(1).max(200).optional(),
      engineHint: engineHintSchema.optional(),
    })
    .optional(),
  game: z
    .strictObject({
      url: z.string().min(1).optional(),
    })
    .optional(),
  browser: z
    .strictObject({
      headless: z.boolean().optional(),
      backend: z.enum(["chromium-shell", "chromium"]).optional(),
      viewport: z
        .strictObject({
          width: z.number().int().min(64).max(4096).optional(),
          height: z.number().int().min(64).max(4096).optional(),
        })
        .optional(),
      deviceScaleFactor: z.number().min(0.5).max(4).optional(),
      /** Explicit Chromium binary; env AGENT_PLAYTEST_CHROMIUM_PATH wins over it. */
      executablePath: z.string().min(1).max(1000).optional(),
    })
    .optional(),
  session: z
    .strictObject({
      idleTimeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(24 * 60 * 60 * 1000)
        .optional(),
    })
    .optional(),
  output: z
    .strictObject({
      directory: z.string().min(1).max(500).optional(),
    })
    .optional(),
});

export type ProjectConfigFile = z.infer<typeof projectConfigSchema>;

export interface ResolvedConfig {
  schemaVersion: number;
  project: { name: string; engineHint: "three" | "phaser" | "pixi" | "unknown" };
  game: { url?: string };
  browser: {
    headless: boolean;
    backend: "chromium-shell" | "chromium";
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    executablePath?: string;
  };
  session: { idleTimeoutMs: number };
  output: { directory: string };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  project: { name: "game", engineHint: "unknown" },
  game: {},
  browser: {
    headless: true,
    backend: "chromium-shell",
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 1,
  },
  session: { idleTimeoutMs: 30 * 60 * 1000 },
  output: { directory: ".agent-playtest/output" },
};

export interface ResolveConfigInput {
  /** Built-in defaults, then user config, then project config, then flags. */
  project?: ProjectConfigFile;
  user?: ProjectConfigFile;
  flags?: {
    headless?: boolean;
    url?: string;
    idleTimeoutMs?: number;
    outputDirectory?: string;
    executablePath?: string;
  };
  projectName: string;
}

/**
 * Precedence: explicit flags > project config > user config > built-in defaults.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  // Precedence: user config, then project config, over the built-in defaults.
  const layers: ProjectConfigFile[] = [];
  if (input.user) layers.push(input.user);
  if (input.project) layers.push(input.project);
  const merged: ResolvedConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: {
      name: input.projectName,
      engineHint: DEFAULT_CONFIG.project.engineHint,
    },
    game: {},
    browser: {
      headless: DEFAULT_CONFIG.browser.headless,
      backend: DEFAULT_CONFIG.browser.backend,
      viewport: { ...DEFAULT_CONFIG.browser.viewport },
      deviceScaleFactor: DEFAULT_CONFIG.browser.deviceScaleFactor,
    },
    session: { idleTimeoutMs: DEFAULT_CONFIG.session.idleTimeoutMs },
    output: { directory: DEFAULT_CONFIG.output.directory },
  };

  for (const layer of layers) {
    if (layer.project?.engineHint) merged.project.engineHint = layer.project.engineHint;
    if (layer.game?.url) merged.game.url = layer.game.url;
    if (layer.browser?.headless !== undefined) merged.browser.headless = layer.browser.headless;
    if (layer.browser?.backend) merged.browser.backend = layer.browser.backend;
    if (layer.browser?.viewport?.width)
      merged.browser.viewport.width = layer.browser.viewport.width;
    if (layer.browser?.viewport?.height)
      merged.browser.viewport.height = layer.browser.viewport.height;
    if (layer.browser?.deviceScaleFactor)
      merged.browser.deviceScaleFactor = layer.browser.deviceScaleFactor;
    if (layer.browser?.executablePath) merged.browser.executablePath = layer.browser.executablePath;
    if (layer.session?.idleTimeoutMs) merged.session.idleTimeoutMs = layer.session.idleTimeoutMs;
    if (layer.output?.directory) merged.output.directory = layer.output.directory;
  }

  if (input.flags?.headless !== undefined) merged.browser.headless = input.flags.headless;
  if (input.flags?.url) merged.game.url = input.flags.url;
  if (input.flags?.idleTimeoutMs !== undefined)
    merged.session.idleTimeoutMs = input.flags.idleTimeoutMs;
  if (input.flags?.outputDirectory) merged.output.directory = input.flags.outputDirectory;
  if (input.flags?.executablePath) merged.browser.executablePath = input.flags.executablePath;

  return merged;
}

export const rpcRequestSchema = z.strictObject({
  protocolVersion: z.number().int(),
  requestId: z.string().min(1).max(128),
  token: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(128).optional(),
  command: z.enum(["open", "snapshot", "inspect", "act", "capture", "close", "ping"]),
  params: z.unknown(),
});

export const openParamsSchema = z.strictObject({
  url: z.string().min(1).max(2000).optional(),
  allowRemote: z.boolean().optional(),
  /** Per-invocation browser visibility; only applies before the browser launches. */
  headed: z.boolean().optional(),
});

export const snapshotParamsSchema = z.strictObject({
  depth: z.number().int().min(0).max(64).optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
  delta: z.boolean().optional(),
});

export const inspectParamsSchema = z.strictObject({
  selector: z.string().min(1).max(500),
  details: z.boolean().optional(),
});

export const actParamsSchema = z.strictObject({
  action: z.enum(["keydown", "keyup", "press", "click", "step"]),
  key: z.string().min(1).max(64).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  ticks: z.number().int().min(1).max(10_000).optional(),
});

export const captureParamsSchema = z.strictObject({
  page: z.boolean().optional(),
  selector: z.string().min(1).max(500).optional(),
  views: z.array(z.enum(["front", "back", "left", "right", "top", "bottom", "current"])).optional(),
  out: z.string().min(1).max(1000).optional(),
  overwrite: z.boolean().optional(),
});

export const closeParamsSchema = z.strictObject({});

export function parseConfigFile(
  raw: unknown,
  source: string,
): { ok: true; value: ProjectConfigFile } | { ok: false; message: string } {
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `${source} is not a valid Agent Playtest config: ${issues}` };
  }
  const version = parsed.data.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (version !== CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `${source} uses config schemaVersion ${version}, but this Agent Playtest build supports ${CONFIG_SCHEMA_VERSION}. No automatic migration is performed; update the file or re-run "agent-playtest init".`,
    };
  }
  return { ok: true, value: parsed.data };
}

export const PROTOCOL = PROTOCOL_VERSION;
