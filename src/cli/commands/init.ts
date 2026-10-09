/**
 * `agent-playtest init` — idempotent, non-destructive project workspace creation.
 *
 * It never edits game source, never runs package scripts, and never overwrites
 * an existing user-authored file. Template changes are reported, not applied.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inferProjectName } from "../../shared/config.ts";
import { AgentPlaytestError } from "../../shared/errors.ts";
import {
  atomicWriteFile,
  packageRoot,
  projectPaths,
  resolveInside,
  resolveProjectRoot,
} from "../../shared/paths.ts";
import { detectEngine, type EngineHintName } from "../detect-engine.ts";

export interface InitOptions {
  project?: string;
  linkAgents?: boolean;
}

export interface InitResult {
  projectRoot: string;
  workspace: string;
  created: string[];
  preserved: string[];
  engineHint: EngineHintName;
  engineEvidence: string[];
  templateVersionMismatch: string[];
  agentsLinked: boolean;
  next: string[];
}

const TEMPLATE_VERSION = 1;
const DEFAULT_GAME_URL = "http://127.0.0.1:5173/?agent-playtest=1";
const ROOT_AGENTS_SNIPPET = [
  "## Game testing",
  "When inspecting or testing this browser game, read `.agent-playtest/AGENTS.md` and use the installed `agent-playtest` CLI. Game-specific tests, bugs, and progress live under `.agent-playtest/`.",
].join("\n");

export function runInit(options: InitOptions = {}): InitResult {
  const projectRoot = resolveProjectRoot(options.project);
  assertWritable(projectRoot);
  const paths = projectPaths(projectRoot);
  const detection = detectEngine(projectRoot);
  const projectName = inferProjectName(projectRoot);
  const templateDir = join(packageRoot(), "templates", "project");

  const created: string[] = [];
  const preserved: string[] = [];
  const templateVersionMismatch: string[] = [];

  const bridgeTemplate = detection.hint === "phaser" ? "bridge.phaser.ts" : "bridge.three.ts";
  const files: Array<{
    relative: string;
    template: string;
    transform?: (input: string) => string;
  }> = [
    { relative: ".agent-playtest/AGENTS.md", template: "AGENTS.md" },
    {
      relative: ".agent-playtest/config.json",
      template: "config.json",
      transform: (input) =>
        input
          .replace("{{PROJECT_NAME}}", projectName)
          .replace("{{ENGINE_HINT}}", detection.hint)
          .replace("{{GAME_URL}}", DEFAULT_GAME_URL),
    },
    { relative: ".agent-playtest/bridge.ts", template: bridgeTemplate },
    { relative: ".agent-playtest/progress.md", template: "progress.md" },
    { relative: ".agent-playtest/.gitignore", template: "gitignore" },
  ];

  for (const file of files) {
    const templateText = readTemplate(join(templateDir, file.template));
    const rendered = file.transform ? file.transform(templateText) : templateText;
    const destination = resolveInside(projectRoot, file.relative, "init file");
    if (existsSync(destination)) {
      preserved.push(file.relative);
      const existing = safeRead(destination);
      if (existing !== undefined) {
        const existingVersion = readTemplateVersion(existing);
        const templateVersion = readTemplateVersion(templateText);
        if (
          existingVersion !== undefined &&
          templateVersion !== undefined &&
          existingVersion !== templateVersion
        ) {
          templateVersionMismatch.push(
            `${file.relative} was created from template version ${existingVersion}; this CLI ships version ${templateVersion}. Review the new template and update it manually — Agent Playtest never overwrites your file.`,
          );
        }
      }
      continue;
    }
    atomicWriteFile(destination, ensureTrailingNewline(rendered));
    created.push(file.relative);
  }

  for (const directory of [".agent-playtest/tests", ".agent-playtest/bugs"]) {
    const destination = resolveInside(projectRoot, directory, "init directory");
    const keep = join(destination, ".gitkeep");
    if (!existsSync(keep)) {
      atomicWriteFile(keep, "");
      created.push(`${directory}/.gitkeep`);
    }
  }

  let agentsLinked = false;
  if (options.linkAgents) {
    agentsLinked = linkRootAgents(projectRoot);
  }

  const next = [
    "Next: ask your coding agent to read .agent-playtest/AGENTS.md and connect the running scene.",
  ];
  if (detection.hint === "unknown") {
    next.push(
      "No engine was detected from project evidence. Open .agent-playtest/bridge.ts and connect the real references manually.",
    );
  }
  next.push("Then: agent-playtest open http://127.0.0.1:5173/?agent-playtest=1");
  if (options.linkAgents && !agentsLinked) {
    next.push("Root AGENTS.md already referenced .agent-playtest/AGENTS.md; no change was made.");
  }

  return {
    projectRoot,
    workspace: paths.workspace,
    created,
    preserved,
    engineHint: detection.hint,
    engineEvidence: detection.evidence,
    templateVersionMismatch,
    agentsLinked,
    next,
  };
}

function linkRootAgents(projectRoot: string): boolean {
  const target = join(projectRoot, "AGENTS.md");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existing.includes(".agent-playtest/AGENTS.md")) return false;
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  atomicWriteFile(target, `${existing}${separator}${ROOT_AGENTS_SNIPPET}\n`);
  return true;
}

function readTemplate(path: string): string {
  if (!existsSync(path)) {
    throw new AgentPlaytestError({
      code: "INTERNAL_ERROR",
      message: `Bundled template is missing: ${path}`,
      hint: "The npm package was packed without its templates. Reinstall agent-playtest.",
    });
  }
  return readFileSync(path, "utf8");
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readTemplateVersion(contents: string): number | undefined {
  const match = /agent-playtest-template-version:\s*(\d+)/.exec(contents);
  return match ? Number(match[1]) : undefined;
}

function ensureTrailingNewline(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function assertWritable(projectRoot: string): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(projectRoot);
  } catch (error) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: `Cannot read project directory ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!stats.isDirectory()) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: `Project path is not a directory: ${projectRoot}`,
    });
  }
}

export { TEMPLATE_VERSION };
