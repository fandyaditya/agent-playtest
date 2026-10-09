/**
 * Daemon process entry point.
 *
 * Started detached by the CLI with an explicit socket path, metadata path and
 * shared token. It owns exactly one project session and exits on idle timeout,
 * explicit `close`, or a termination signal.
 */

import { appendFileSync, statSync, truncateSync } from "node:fs";
import { loadProjectConfig } from "../shared/config.ts";
import { clearSessionMeta, ensureMachineDirs, writeSessionMeta } from "../shared/paths.ts";
import { CONFIG_SCHEMA_VERSION, PROTOCOL_VERSION } from "../shared/types.ts";
import { DaemonServer } from "./server.ts";
import { ProjectSession } from "./sessions.ts";

interface DaemonArgs {
  project: string;
  socket: string;
  meta: string;
  token: string;
  sessionId: string;
  idleTimeoutMs: number;
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

function parseArgs(argv: string[]): DaemonArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) continue;
    values.set(token.slice(2), next);
    index += 1;
  }
  for (const key of ["project", "socket", "meta", "token", "session-id"] as const) {
    if (!values.get(key)) throw new Error(`Missing required daemon argument --${key}`);
  }
  return {
    project: values.get("project") as string,
    socket: values.get("socket") as string,
    meta: values.get("meta") as string,
    token: values.get("token") as string,
    sessionId: values.get("session-id") as string,
    idleTimeoutMs: Number(values.get("idle-timeout") ?? 30 * 60 * 1000),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { logs } = ensureMachineDirs();
  const logPath = `${logs}/${args.sessionId}.log`;

  const log = (message: string): void => {
    try {
      const stats = statSync(logPath, { throwIfNoEntry: false });
      if (stats && stats.size > MAX_LOG_BYTES) truncateSync(logPath, 0);
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never take the daemon down.
    }
  };

  const config = loadProjectConfig(args.project);
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    session.shutdown();
    try {
      await session.close();
    } catch (error) {
      log(`Error while closing the session: ${String(error)}`);
    }
    try {
      await server.stop();
    } catch {
      // ignore
    }
    clearSessionMeta({ key: "", socketPath: args.socket, metaPath: args.meta, logPath });
    process.exit(code);
  };

  const session = new ProjectSession({
    projectRoot: args.project,
    config,
    sessionId: args.sessionId,
    idleTimeoutMs: args.idleTimeoutMs,
    onIdle: () => {
      void shutdown(0);
    },
    log,
  });

  const server = new DaemonServer({
    socketPath: args.socket,
    token: args.token,
    session,
    log,
  });

  await server.start();

  writeSessionMeta(
    { key: "", socketPath: args.socket, metaPath: args.meta, logPath },
    {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: args.sessionId,
      pid: process.pid,
      socketPath: args.socket,
      projectRoot: args.project,
      token: args.token,
      startedAt: new Date().toISOString(),
    },
  );

  session.touch();
  log(`Daemon ready (protocol ${PROTOCOL_VERSION}, schema ${CONFIG_SCHEMA_VERSION}).`);

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    log(`Uncaught exception: ${error.stack ?? error.message}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    log(`Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((error) => {
  console.error(`agent-playtest daemon failed to start: ${String(error)}`);
  process.exit(1);
});
