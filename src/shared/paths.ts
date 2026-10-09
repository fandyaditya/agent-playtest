/**
 * Filesystem contracts: project workspace (`<project>/.gameprob/`) and machine
 * home (`~/.gameprob/`). All generated writes go through the safe helpers here
 * so path traversal and symlink escapes are rejected in one place.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GameProbError } from "./errors.ts";

export const PROJECT_DIR_NAME = ".gameprob";

/** Walk up from this module until the owning package.json is found. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new GameProbError({
        code: "INTERNAL_ERROR",
        message: "Could not locate the GameProb package root.",
      });
    }
    dir = parent;
  }
}

export function packageVersion(): string {
  const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

export function machineHome(): string {
  const override = process.env.GAMEPROB_HOME;
  if (override && override.trim().length > 0) return resolve(override);
  return join(homedir(), ".gameprob");
}

export function ensureMachineDirs(): { home: string; sessions: string; logs: string } {
  const home = machineHome();
  const sessions = join(home, "sessions");
  const logs = join(home, "logs");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  restrictPermissions(home, 0o700);
  restrictPermissions(sessions, 0o700);
  restrictPermissions(logs, 0o700);
  return { home, sessions, logs };
}

function restrictPermissions(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort: some filesystems (mounted volumes, CI caches) reject chmod.
  }
}

export function projectKey(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
}

export interface SessionEndpoint {
  key: string;
  socketPath: string;
  metaPath: string;
  logPath: string;
}

/**
 * Unix domain sockets have a platform path limit (108 bytes on Linux, 104 on
 * macOS). A deeply nested home directory can exceed it, so fall back to a short
 * path in the OS temporary directory. The socket stays 0600 and token-gated
 * either way; only its path moves.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export function sessionEndpoint(canonicalRoot: string): SessionEndpoint {
  const { sessions, logs } = ensureMachineDirs();
  const key = projectKey(canonicalRoot);
  return {
    key,
    socketPath: socketPathFor(sessions, key),
    metaPath: join(sessions, `${key}.json`),
    logPath: join(logs, `${key}.log`),
  };
}

function socketPathFor(sessionsDir: string, key: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\gameprob-${key}`;
  const preferred = join(sessionsDir, `${key}.sock`);
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH_BYTES) return preferred;
  return join(tmpdir(), `gameprob-${key}.sock`);
}

export interface SessionMeta {
  schemaVersion: number;
  protocolVersion: number;
  sessionId: string;
  pid: number;
  socketPath: string;
  projectRoot: string;
  token: string;
  startedAt: string;
}

export function writeSessionMeta(endpoint: SessionEndpoint, meta: SessionMeta): void {
  atomicWriteJson(endpoint.metaPath, meta, 0o600);
}

export function readSessionMeta(endpoint: SessionEndpoint): SessionMeta | null {
  if (!existsSync(endpoint.metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(endpoint.metaPath, "utf8")) as SessionMeta;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSessionMeta(endpoint: SessionEndpoint): void {
  for (const path of [endpoint.metaPath, endpoint.socketPath]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user.
    return code === "EPERM";
  }
}

export function canonicalize(dir: string): string {
  const absolute = resolve(dir);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveProjectRoot(explicit?: string): string {
  const candidate = explicit ? resolve(explicit) : process.cwd();
  if (!existsSync(candidate)) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Project directory does not exist: ${candidate}`,
    });
  }
  const stats = statSync(candidate);
  if (!stats.isDirectory()) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Project path is not a directory: ${candidate}`,
    });
  }
  return canonicalize(candidate);
}

export interface ProjectPaths {
  root: string;
  workspace: string;
  configFile: string;
  agentsFile: string;
  bridgeFile: string;
  progressFile: string;
  testsDir: string;
  bugsDir: string;
  outputDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  const workspace = join(root, PROJECT_DIR_NAME);
  return {
    root,
    workspace,
    configFile: join(workspace, "config.json"),
    agentsFile: join(workspace, "AGENTS.md"),
    bridgeFile: join(workspace, "bridge.ts"),
    progressFile: join(workspace, "progress.md"),
    testsDir: join(workspace, "tests"),
    bugsDir: join(workspace, "bugs"),
    outputDir: join(workspace, "output"),
  };
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a user-supplied path that must stay inside `root`.
 * Rejects `..` traversal and symlinks that escape the root.
 */
export function resolveInside(root: string, candidate: string, label = "path"): string {
  const absolute = resolve(root, candidate);
  const realRoot = canonicalize(root);
  if (!isInside(realRoot, absolute)) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `Refusing to write outside the project: ${label} resolves to ${absolute}`,
    });
  }
  // If an ancestor already exists, follow symlinks and re-check.
  let probe = dirname(absolute);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (existsSync(probe)) {
    const realProbe = canonicalize(probe);
    if (!isInside(realRoot, realProbe)) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: `Refusing to follow a symlink out of the project: ${label} (${probe} -> ${realProbe})`,
      });
    }
  }
  return absolute;
}

export function atomicWriteFile(path: string, contents: string, mode?: number): void {
  atomicWriteBuffer(path, Buffer.from(contents, "utf8"), mode);
}

export function atomicWriteBuffer(path: string, contents: Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, mode === undefined ? {} : { mode });
  renameSync(tmp, path);
}

export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function pathSeparator(): string {
  return sep;
}
