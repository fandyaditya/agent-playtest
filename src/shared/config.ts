/**
 * Config loading and precedence for consumer projects.
 *
 * Files on disk are untrusted input: they are parsed with Zod and every failure
 * becomes an actionable `CONFIG_INVALID` error instead of a stack trace.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { GameProbError } from "./errors.ts";
import { machineHome, PROJECT_DIR_NAME, readJsonFile } from "./paths.ts";
import {
  type ProjectConfigFile,
  parseConfigFile,
  type ResolvedConfig,
  resolveConfig,
} from "./schemas.ts";

export function loadProjectConfig(projectRoot: string): ResolvedConfig {
  const projectName = inferProjectName(projectRoot);
  const projectFile = readConfigFile(join(projectRoot, PROJECT_DIR_NAME, "config.json"));
  const userFile = readConfigFile(join(machineHome(), "config.json"));

  return resolveConfig({
    projectName,
    ...(projectFile ? { project: projectFile } : {}),
    ...(userFile ? { user: userFile } : {}),
    // The environment is a machine-local override, so it ranks above config files.
    ...(process.env.GAMEPROB_CHROMIUM_PATH
      ? { flags: { executablePath: process.env.GAMEPROB_CHROMIUM_PATH } }
      : {}),
  });
}

export function readConfigFile(path: string): ProjectConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (error) {
    throw new GameProbError({
      code: "CONFIG_INVALID",
      message: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const parsed = parseConfigFile(raw, path);
  if (!parsed.ok) {
    throw new GameProbError({ code: "CONFIG_INVALID", message: parsed.message });
  }
  return parsed.value;
}

export function inferProjectName(projectRoot: string): string {
  const packageFile = join(projectRoot, "package.json");
  if (existsSync(packageFile)) {
    try {
      const parsed = readJsonFile(packageFile) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        return parsed.name.replace(/^@[^/]+\//, "").slice(0, 120);
      }
    } catch {
      // Fall through to the directory name.
    }
  }
  return basename(projectRoot) || "game";
}
