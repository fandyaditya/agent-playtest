/**
 * CLI-side daemon client: find a live daemon, start one when missing, and send
 * one length-prefixed RPC request.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { AgentPlaytestError } from "../shared/errors.ts";
import {
  clearSessionMeta,
  isProcessAlive,
  packageRoot,
  readSessionMeta,
  type SessionEndpoint,
  sessionEndpoint,
} from "../shared/paths.ts";
import { PROTOCOL_VERSION, type RpcRequest, type RpcResponse } from "../shared/types.ts";
import { createMessageDecoder, encodeMessage } from "./framing.ts";

export interface DaemonHandle {
  endpoint: SessionEndpoint;
  sessionId: string;
  token: string;
}

/**
 * The daemon is a separate process, so it cannot be bundled into the CLI chunk:
 * resolve its entry from the package layout, preferring the built output.
 */
export function daemonEntryPath(): string {
  const root = packageRoot();
  const candidates = [
    join(root, "dist", "daemon", "entry.js"),
    join(root, "src", "daemon", "entry.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AgentPlaytestError({
    code: "INTERNAL_ERROR",
    message: "Could not locate the Agent Playtest daemon entry point.",
    hint: "The package is incomplete; reinstall agent-playtest.",
  });
}

/** Returns the live daemon for a project, or null when there is none. */
export async function findDaemon(projectRoot: string): Promise<DaemonHandle | null> {
  const endpoint = sessionEndpoint(projectRoot);
  const meta = readSessionMeta(endpoint);
  if (!meta) return null;
  if (meta.projectRoot !== projectRoot) return null;
  if (meta.protocolVersion !== PROTOCOL_VERSION) return null;
  if (!isProcessAlive(meta.pid)) return null;
  if (!(await ping(endpoint.socketPath, meta.token, 2000))) return null;
  return { endpoint, sessionId: meta.sessionId, token: meta.token };
}

export interface EnsureDaemonOptions {
  projectRoot: string;
  idleTimeoutMs: number;
  startupTimeoutMs?: number;
  /** Defaults to the machine-home log for this project's session endpoint. */
  logPath?: string;
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHandle> {
  const endpoint = sessionEndpoint(options.projectRoot);
  const existing = readSessionMeta(endpoint);

  if (existing) {
    const sameProject = existing.projectRoot === options.projectRoot;
    const compatible = existing.protocolVersion === PROTOCOL_VERSION;
    if (sameProject && compatible && isProcessAlive(existing.pid)) {
      if (await ping(endpoint.socketPath, existing.token, 2000)) {
        return { endpoint, sessionId: existing.sessionId, token: existing.token };
      }
    }
    await retireDaemon(endpoint, existing.pid, compatible);
  }

  return startDaemon(options, endpoint);
}

/**
 * Removes a stale or version-mismatched daemon entry. A live daemon is only
 * signalled when it is verifiably ours (recorded in our own session file AND,
 * on Linux, its command line names the Agent Playtest daemon entry point).
 */
export async function retireDaemon(
  endpoint: SessionEndpoint,
  pid: number,
  compatible: boolean,
): Promise<void> {
  if (!compatible && isProcessAlive(pid) && looksLikeOurDaemon(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
    await waitForExit(pid, 3000);
  }
  clearSessionMeta(endpoint);
}

export async function startDaemon(
  options: EnsureDaemonOptions,
  endpoint: SessionEndpoint,
): Promise<DaemonHandle> {
  const token = randomBytes(24).toString("hex");
  const sessionId = `s_${randomBytes(4).toString("hex")}`;
  const entryPath = daemonEntryPath();
  const logPath = options.logPath ?? endpoint.logPath;

  const logFd = openSync(logPath, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [
        entryPath,
        "--project",
        options.projectRoot,
        "--socket",
        endpoint.socketPath,
        "--meta",
        endpoint.metaPath,
        "--token",
        token,
        "--session-id",
        sessionId,
        "--idle-timeout",
        String(options.idleTimeoutMs),
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
      },
    );
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const meta = readSessionMeta(endpoint);
    if (meta && meta.token === token && isProcessAlive(meta.pid)) {
      if (await ping(endpoint.socketPath, token, 2000)) {
        return { endpoint, sessionId: meta.sessionId, token };
      }
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new AgentPlaytestError({
        code: "SESSION_NOT_FOUND",
        message: `The Agent Playtest daemon exited during startup with code ${child.exitCode}.`,
        hint: `Check the daemon log: ${logPath}`,
      });
    }
    await delay(100);
  }

  throw new AgentPlaytestError({
    code: "SESSION_NOT_FOUND",
    message: `The Agent Playtest daemon did not become ready within ${startupTimeoutMs}ms.`,
    hint: `Check the daemon log: ${logPath}`,
  });
}

export interface SendOptions {
  timeoutMs?: number;
}

export async function sendCommand<T>(
  handle: DaemonHandle,
  command: RpcRequest["command"],
  params: unknown,
  options: SendOptions = {},
): Promise<RpcResponse<T>> {
  const request: RpcRequest = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    token: handle.token,
    sessionId: handle.sessionId,
    command,
    params,
  };
  return await sendRaw<T>(handle.endpoint.socketPath, request, options.timeoutMs ?? 120_000);
}

async function sendRaw<T>(
  socketPath: string,
  request: RpcRequest,
  timeoutMs: number,
): Promise<RpcResponse<T>> {
  const command = request.command;
  return await new Promise<RpcResponse<T>>((resolve, reject) => {
    let settled = false;
    const socket: Socket = connect(socketPath);

    const finish = (error: Error | null, response?: RpcResponse<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response as RpcResponse<T>);
    };

    const timer = setTimeout(() => {
      finish(
        new AgentPlaytestError({
          code: "SESSION_NOT_FOUND",
          message: `The daemon did not answer "${command}" within ${timeoutMs}ms.`,
          hint: "The session may be stuck. Run `agent-playtest close` and retry.",
        }),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      try {
        socket.write(encodeMessage(request));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const decoder = createMessageDecoder({
      onMessage: (value) => finish(null, value as RpcResponse<T>),
      onError: (error) => finish(error),
    });
    socket.on("data", (chunk) => decoder(chunk));
    socket.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        finish(
          new AgentPlaytestError({
            code: "SESSION_NOT_FOUND",
            message: "The Agent Playtest daemon is not reachable.",
            hint: "It may have exited. Retry; a new daemon starts automatically.",
          }),
        );
        return;
      }
      finish(error);
    });
  });
}

async function ping(socketPath: string, token: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await sendRaw<{ pong: boolean }>(
      socketPath,
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        token,
        command: "ping",
        params: {},
      },
      timeoutMs,
    );
    return response.ok === true;
  } catch {
    return false;
  }
}

function looksLikeOurDaemon(pid: number): boolean {
  if (process.platform !== "linux") return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("agent-playtest") && cmdline.includes("entry");
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
