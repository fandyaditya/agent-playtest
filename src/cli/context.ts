/**
 * Shared CLI plumbing: project/config resolution and daemon calls.
 */

import { existsSync } from "node:fs";
import { type DaemonHandle, ensureDaemon, findDaemon, sendCommand } from "../daemon/client.ts";
import { loadProjectConfig } from "../shared/config.ts";
import { AgentPlaytestError, type ErrorCode } from "../shared/errors.ts";
import { type ProjectPaths, projectPaths, resolveProjectRoot } from "../shared/paths.ts";
import type { ResolvedConfig } from "../shared/schemas.ts";
import type { RpcResponse } from "../shared/types.ts";

export interface CliContext {
  projectRoot: string;
  config: ResolvedConfig;
  paths: ProjectPaths;
}

export interface CommandResult<T> {
  data: T;
  warnings: string[];
  sessionId?: string;
}

export function loadContext(
  options: { project?: string; requireWorkspace?: boolean } = {},
): CliContext {
  const projectRoot = resolveProjectRoot(options.project);
  const paths = projectPaths(projectRoot);
  if (options.requireWorkspace && !existsSync(paths.configFile)) {
    throw new AgentPlaytestError({
      code: "PROJECT_NOT_INITIALIZED",
      message: `No Agent Playtest workspace found at ${paths.workspace}.`,
      hint: "Run `agent-playtest init` in the game project first.",
    });
  }
  return { projectRoot, config: loadProjectConfig(projectRoot), paths };
}

export async function ensureSession(context: CliContext): Promise<DaemonHandle> {
  return ensureDaemon({
    projectRoot: context.projectRoot,
    idleTimeoutMs: context.config.session.idleTimeoutMs,
  });
}

export async function existingSession(context: CliContext): Promise<DaemonHandle | null> {
  return findDaemon(context.projectRoot);
}

export async function callDaemon<T>(
  context: CliContext,
  command: "open" | "snapshot" | "inspect" | "act" | "capture" | "close",
  params: unknown,
  options: { timeoutMs?: number; requireSession?: boolean } = {},
): Promise<CommandResult<T>> {
  const handle =
    options.requireSession === true ? await existingSession(context) : await ensureSession(context);
  if (!handle) {
    throw new AgentPlaytestError({
      code: "SESSION_NOT_FOUND",
      message: "No Agent Playtest session is open for this project.",
      hint: "Run `agent-playtest open <url>` first.",
    });
  }

  const response: RpcResponse<T> = await sendCommand<T>(handle, command, params, {
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) {
    const error = response.error;
    throw new AgentPlaytestError({
      code: (error?.code as ErrorCode) ?? "INTERNAL_ERROR",
      message: error?.message ?? `Command "${command}" failed.`,
      ...(error?.missing ? { missing: error.missing } : {}),
      ...(error?.hint ? { hint: error.hint } : {}),
    });
  }

  return {
    data: response.data as T,
    warnings: response.warnings ?? [],
    ...(response.sessionId ? { sessionId: response.sessionId } : {}),
  };
}
