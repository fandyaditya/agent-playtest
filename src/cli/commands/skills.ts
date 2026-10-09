/**
 * `gameprob skills get core` — the version-matched agent guide.
 *
 * Reads the guide bundled with the *installed* package so the documented CLI
 * surface always matches the shipped one. Works with no browser, daemon or game.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GameProbError } from "../../shared/errors.ts";
import { packageRoot, packageVersion } from "../../shared/paths.ts";

export interface SkillsResult {
  content: string;
  version: string;
  full: boolean;
}

export function runSkillsGetCore(options: { full?: boolean } = {}): SkillsResult {
  const version = packageVersion();
  const full = options.full === true;
  const files = full ? ["core.md", "reference.md"] : ["core.md"];
  const content = files
    .map((file) => readSkillData(file).replaceAll("{{VERSION}}", version))
    .join("\n\n---\n\n");
  return { content, version, full };
}

function readSkillData(file: string): string {
  const path = join(packageRoot(), "skill-data", file);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new GameProbError({
      code: "INTERNAL_ERROR",
      message: `Bundled skill data is missing: ${path}`,
      hint: "The npm package was packed without skill-data. Reinstall gameprob.",
      cause: error,
    });
  }
}
