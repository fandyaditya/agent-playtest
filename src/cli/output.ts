/**
 * stdout/stderr policy.
 *
 * Data goes to stdout (text or `--json`), diagnostics to stderr. ANSI color is
 * emitted only on a TTY and never in JSON. Human output is a projection of the
 * same envelope the daemon returns.
 */

import { type AgentPlaytestError, EXIT_CODES } from "../shared/errors.ts";
import { PROTOCOL_VERSION, type ResultEnvelope } from "../shared/types.ts";

export interface EmitOptions {
  json: boolean;
  sessionId?: string;
}

export class Output {
  #json: boolean;
  #debug: boolean;

  constructor(options: { json: boolean; debug?: boolean }) {
    this.#json = options.json;
    this.#debug = options.debug === true;
  }

  get json(): boolean {
    return this.#json;
  }

  success<T>(
    command: string,
    data: T,
    warnings: string[] = [],
    options: EmitOptions = { json: this.#json },
  ): void {
    const durationMs = 0;
    if (this.#json) {
      const envelope: ResultEnvelope<T> = {
        protocolVersion: PROTOCOL_VERSION,
        ok: true,
        command,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        data,
        warnings,
        durationMs,
      };
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return;
    }
    for (const line of renderSuccess(command, data)) process.stdout.write(`${line}\n`);
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  }

  failure(
    command: string,
    error: AgentPlaytestError,
    options: EmitOptions = { json: this.#json },
  ): number {
    const exitCode = EXIT_CODES[error.code] ?? 1;
    if (this.#json) {
      const envelope: ResultEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        ok: false,
        command,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        error: error.toEnvelope(),
        warnings: [],
        durationMs: 0,
      };
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return exitCode;
    }
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    if (error.missing && error.missing.length > 0) {
      process.stderr.write(`missing: ${error.missing.join(", ")}\n`);
    }
    if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
    if (this.#debug && error.stack) process.stderr.write(`${error.stack}\n`);
    return exitCode;
  }
}

function renderSuccess(command: string, data: unknown): string[] {
  switch (command) {
    case "init":
      return renderInit(data as InitData);
    case "open":
      return renderOpen(data as OpenData);
    case "snapshot":
      return renderSnapshot(data as SnapshotData);
    case "inspect":
      return renderInspect(data as InspectData);
    case "act":
      return renderAct(data as { action: string; detail?: string; ticks?: number });
    case "capture":
      return renderCapture(data as CaptureData);
    case "run":
      return renderRun(data as RunData);
    case "close":
      return renderClose(data as CloseData);
    case "skills":
      return [String((data as { content: string }).content)];
    default:
      return [JSON.stringify(data, null, 2)];
  }
}

interface InitData {
  projectRoot: string;
  workspace: string;
  created: string[];
  preserved: string[];
  engineHint: string;
  engineEvidence: string[];
  templateVersionMismatch?: string[];
  next: string[];
}

function renderInit(data: InitData): string[] {
  const lines = [`Agent Playtest initialized: ${data.workspace}`];
  if (data.engineHint !== "unknown") {
    lines.push(`Engine hint from project evidence: ${data.engineHint} (a hint, not a live check)`);
  } else {
    lines.push("Engine not detected from project evidence (hint only; not a live check)");
  }
  if (data.created.length > 0) lines.push(`Created: ${data.created.join(", ")}`);
  if (data.preserved.length > 0)
    lines.push(`Preserved (already existed): ${data.preserved.join(", ")}`);
  for (const note of data.templateVersionMismatch ?? []) lines.push(`Note: ${note}`);
  for (const line of data.next) lines.push(line);
  return lines;
}

interface OpenData {
  url: string;
  browser: string;
  bridge: { connected: boolean; engine?: string; bridgeVersion?: number };
  readiness: { domReady: boolean; gameReady: boolean | "unknown" };
  capabilities: { features: Record<string, boolean> };
}

function renderOpen(data: OpenData): string[] {
  const lines = [`Opened: ${data.url}`, `Browser: ${data.browser}`];
  lines.push(
    data.bridge.connected
      ? `Bridge: connected (${data.bridge.engine})`
      : "Bridge: not detected (browser-only mode)",
  );
  const enabled = Object.entries(data.capabilities.features)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .sort();
  lines.push(`Capabilities: ${enabled.join(", ")}`);
  lines.push(
    `Game ready: ${data.readiness.gameReady === "unknown" ? "unknown" : String(data.readiness.gameReady)}`,
  );
  if (!data.bridge.connected) {
    lines.push(
      "Tip: run agent-playtest init and connect the development-only bridge for scene inspection.",
    );
  }
  return lines;
}

interface SnapshotData {
  meta: {
    mode: string;
    engine: string;
    sceneName?: string;
    revision: number;
    baseRevision?: number;
    depth: number;
    objectsShown: number;
    objectsTotal: number;
    truncated: boolean;
  };
  objects: Array<{
    ref: string;
    name: string;
    kind: string;
    engineType: string;
    selector?: string;
    position?: number[];
    childCount?: number;
    visible?: boolean;
  }>;
  delta?: { added: unknown[]; updated: unknown[]; removed: string[] };
  warnings: Array<{ check: string; message: string }>;
}

function renderSnapshot(data: SnapshotData): string[] {
  const lines: string[] = [];
  const scene = data.meta.sceneName ? `${data.meta.sceneName} | ` : "";
  lines.push(
    `Scene: ${scene}Engine: ${data.meta.engine} | Revision: ${data.meta.revision}${data.meta.baseRevision !== undefined ? ` (delta from ${data.meta.baseRevision})` : ""}`,
  );
  for (const object of data.objects) {
    const parts = [object.ref, object.kind, `"${object.name}"`];
    if (object.selector) parts.push(`[${object.selector}]`);
    if (object.position) parts.push(`position=[${object.position.join(",")}]`);
    if (object.childCount !== undefined) parts.push(`children=${object.childCount}`);
    if (object.visible === false) parts.push("hidden");
    lines.push(parts.join(" "));
  }
  if (data.delta) {
    lines.push(
      `Delta: +${data.delta.added.length} ~${data.delta.updated.length} -${data.delta.removed.length}`,
    );
  }
  lines.push(
    `Objects shown: ${data.meta.objectsShown} (of ${data.meta.objectsTotal}); depth: ${data.meta.depth}; truncated: ${data.meta.truncated}`,
  );
  lines.push(`Warnings: ${data.warnings.length} from enabled checks (not proof of no defects)`);
  for (const warning of data.warnings) lines.push(`  - [${warning.check}] ${warning.message}`);
  return lines;
}

interface InspectData {
  ref?: string;
  selector?: string;
  name: string;
  kind: string;
  engineType: string;
  coordinateSpace: string;
  visible?: boolean;
  worldPosition?: number[];
  rotation?: number[];
  scale?: number[];
  bounds?: { size: number[] };
  warnings: Array<{ check: string; message: string }>;
}

function renderInspect(data: InspectData): string[] {
  const lines = [`${data.ref ?? "(no ref)"} ${data.kind} "${data.name}" (${data.engineType})`];
  if (data.selector) lines.push(`Selector: ${data.selector}`);
  lines.push(`Coordinate space: ${data.coordinateSpace}`);
  if (data.visible !== undefined) lines.push(`Visible: ${data.visible}`);
  if (data.worldPosition) lines.push(`World position: [${data.worldPosition.join(", ")}]`);
  if (data.rotation) lines.push(`Rotation: [${data.rotation.join(", ")}]`);
  if (data.scale) lines.push(`Scale: [${data.scale.join(", ")}]`);
  if (data.bounds) lines.push(`Bounds size: [${data.bounds.size.join(", ")}]`);
  lines.push(`Warnings: ${data.warnings.length}`);
  for (const warning of data.warnings) lines.push(`  - [${warning.check}] ${warning.message}`);
  return lines;
}

function renderAct(data: { action: string; detail?: string; ticks?: number }): string[] {
  if (data.ticks !== undefined) return [`Stepped ${data.ticks} simulation ticks`];
  return [`${data.action}${data.detail ? ` ${data.detail}` : ""}`];
}

interface CaptureData {
  kind: string;
  subject?: { name?: string; selector?: string };
  views: Array<{ view: string; path: string; width: number; height: number; bytes: number }>;
  manifestPath?: string;
}

function renderCapture(data: CaptureData): string[] {
  const lines: string[] = [];
  for (const view of data.views) {
    lines.push(
      `Captured ${view.view}: ${view.path} (${view.width}x${view.height}, ${view.bytes} bytes)`,
    );
  }
  if (data.manifestPath) lines.push(`Manifest: ${data.manifestPath}`);
  return lines;
}

interface RunData {
  runId: string;
  runDir: string;
  expected: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  resultFile: string;
}

function renderRun(data: RunData): string[] {
  return [
    `Run ${data.runId}: ${data.passed}/${data.expected} passed, ${data.failed} failed, ${data.skipped} skipped, ${data.flaky} flaky`,
    `Evidence: ${data.runDir}`,
    `Results: ${data.resultFile}`,
  ];
}

interface CloseData {
  closed: boolean;
  sessionId?: string;
  alreadyClosed?: boolean;
}

function renderClose(data: CloseData): string[] {
  if (data.alreadyClosed)
    return ["No active Agent Playtest session for this project (already closed)."];
  return [`Closed session ${data.sessionId ?? ""}`.trim()];
}
