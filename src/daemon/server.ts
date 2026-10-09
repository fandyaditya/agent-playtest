/**
 * Local IPC server.
 *
 * Unix socket (macOS/Linux) or Windows named pipe (Windows), per-user
 * permissions, shared-token handshake, versioned request/response envelope and
 * a bounded serial queue per session. Never a TCP listener.
 */

import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { GameProbError, toGameProbError } from "../shared/errors.ts";
import {
  actParamsSchema,
  captureParamsSchema,
  inspectParamsSchema,
  openParamsSchema,
  rpcRequestSchema,
  snapshotParamsSchema,
} from "../shared/schemas.ts";
import { PROTOCOL_VERSION, type RpcRequest, type RpcResponse } from "../shared/types.ts";
import { createMessageDecoder, encodeMessage } from "./framing.ts";
import { SerialQueue } from "./queue.ts";
import type { ProjectSession } from "./sessions.ts";

export interface DaemonServerOptions {
  socketPath: string;
  token: string;
  session: ProjectSession;
  log(message: string): void;
  commandTimeoutMs?: number;
}

interface HandlerOutcome {
  data: unknown;
  warnings: string[];
}

export class DaemonServer {
  #options: DaemonServerOptions;
  #server: Server | null = null;
  #queue = new SerialQueue();
  #clients = new Set<Socket>();
  #stopping = false;
  #commandTimeoutMs: number;

  constructor(options: DaemonServerOptions) {
    this.#options = options;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  async start(): Promise<void> {
    if (process.platform !== "win32") {
      try {
        rmSync(this.#options.socketPath, { force: true });
      } catch {
        // ignore
      }
    }
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.#options.socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    if (process.platform !== "win32") {
      try {
        chmodSync(this.#options.socketPath, 0o600);
      } catch {
        // Best effort on filesystems that do not support chmod.
      }
    }
    this.#options.log(`Daemon listening on ${this.#options.socketPath}`);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    for (const client of this.#clients) client.destroy();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close(() => resolve());
    });
    this.#server = null;
  }

  #handleConnection(socket: Socket): void {
    this.#clients.add(socket);
    socket.on("close", () => this.#clients.delete(socket));
    socket.on("error", () => socket.destroy());

    const decoder = createMessageDecoder({
      onMessage: (value) => {
        void this.#handleRequest(socket, value);
      },
      onError: (error) => {
        this.#options.log(`IPC framing error: ${error.message}`);
        socket.destroy();
      },
    });

    socket.on("data", (chunk) => decoder(chunk));
  }

  async #handleRequest(socket: Socket, raw: unknown): Promise<void> {
    const parsed = rpcRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.#options.log("Rejected a malformed IPC request.");
      socket.destroy();
      return;
    }
    const request = parsed.data as RpcRequest;

    if (request.token !== this.#options.token) {
      this.#options.log("Rejected an IPC request with an invalid session token.");
      socket.destroy();
      return;
    }

    if (request.protocolVersion !== PROTOCOL_VERSION) {
      this.#send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        command: request.command,
        error: {
          code: "IPC_PROTOCOL_MISMATCH",
          message: `This daemon speaks IPC protocol ${PROTOCOL_VERSION}; the client asked for ${request.protocolVersion}.`,
          hint: "Run `gameprob close` and retry so a version-matched daemon starts.",
        },
        warnings: [],
        durationMs: 0,
      });
      return;
    }

    const started = Date.now();
    try {
      const outcome = await this.#queue.run(() => this.#withTimeout(() => this.#dispatch(request)));
      this.#options.session.touch();
      this.#send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: this.#options.session.sessionId,
        ok: true,
        command: request.command,
        data: outcome.data,
        warnings: outcome.warnings,
        durationMs: Date.now() - started,
      });
      if (request.command === "close") {
        this.#options.log("Close requested; shutting the daemon down.");
        void this.#shutdownAfterClose();
      }
    } catch (error) {
      const typed =
        error && typeof error === "object" && "issues" in error
          ? parseZodError(error, request.command)
          : toGameProbError(error);
      this.#options.log(`Command ${request.command} failed: ${typed.code} ${typed.message}`);
      this.#send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        sessionId: this.#options.session.sessionId,
        ok: false,
        command: request.command,
        error: typed.toEnvelope(),
        warnings: [],
        durationMs: Date.now() - started,
      });
    }
  }

  async #dispatch(request: RpcRequest): Promise<HandlerOutcome> {
    const session = this.#options.session;
    const params = (request.params ?? {}) as Record<string, unknown>;

    switch (request.command) {
      case "ping":
        return {
          data: { pong: true, sessionId: session.sessionId, browser: session.browserLabel },
          warnings: [],
        };
      case "open": {
        const parsed = openParamsSchema.parse(params);
        const result = await session.open(parsed);
        return { data: result, warnings: result.warnings };
      }
      case "snapshot": {
        const parsed = snapshotParamsSchema.parse(params);
        const result = await session.snapshot(parsed);
        return { data: result, warnings: result.warnings.map((warning) => warning.message) };
      }
      case "inspect": {
        const parsed = inspectParamsSchema.parse(params);
        const result = await session.inspect(parsed);
        return { data: result, warnings: result.warnings.map((warning) => warning.message) };
      }
      case "act": {
        const parsed = actParamsSchema.parse(params);
        const result = await session.act(parsed);
        return { data: result, warnings: result.warnings };
      }
      case "capture": {
        const parsed = captureParamsSchema.parse(params);
        const result = await session.capture(parsed);
        return { data: result, warnings: result.warnings };
      }
      case "close": {
        await session.close();
        return { data: { closed: true, sessionId: session.sessionId }, warnings: [] };
      }
      default:
        throw new GameProbError({
          code: "INVALID_ARGUMENT",
          message: `Unknown command "${String(request.command)}".`,
        });
    }
  }

  async #withTimeout<T>(task: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new GameProbError({
                code: "INTERNAL_ERROR",
                message: `The command exceeded the ${this.#commandTimeoutMs}ms daemon timeout.`,
                hint: "Retry, or raise session.idleTimeoutMs / check for a hung page.",
              }),
            );
          }, this.#commandTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #shutdownAfterClose(): Promise<void> {
    await this.stop();
    this.#options.session.shutdown();
    process.exit(0);
  }

  #send(socket: Socket, response: RpcResponse): void {
    try {
      socket.write(encodeMessage(response));
    } catch (error) {
      this.#options.log(
        `Failed to write IPC response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function parseZodError(error: unknown, command: string): GameProbError {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> })
      .issues;
    const detail = issues
      .map((issue) => `${issue.path.join(".") || "<params>"}: ${issue.message}`)
      .join("; ");
    return new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Invalid parameters for "${command}": ${detail}`,
    });
  }
  return toGameProbError(error);
}
