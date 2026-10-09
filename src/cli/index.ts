#!/usr/bin/env node

/**
 * `gameprob` CLI.
 *
 * A thin, deterministic surface over the daemon. It owns argument parsing,
 * output policy and exit codes; it never makes gameplay decisions and never
 * calls an AI model.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { EXIT_CODES, GameProbError, toGameProbError } from "../shared/errors.ts";
import { packageVersion } from "../shared/paths.ts";
import { runAct } from "./commands/act.ts";
import { runCapture } from "./commands/capture.ts";
import { runClose } from "./commands/close.ts";
import { runInit } from "./commands/init.ts";
import { runInspect } from "./commands/inspect.ts";
import { runOpen } from "./commands/open.ts";
import { runTests } from "./commands/run.ts";
import { runSkillsGetCore } from "./commands/skills.ts";
import { runSnapshot } from "./commands/snapshot.ts";
import type { CommandResult } from "./context.ts";
import { Output } from "./output.ts";

interface GlobalOptions {
  project?: string;
  json?: boolean;
  debug?: boolean;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("gameprob")
    .description("Inspect, interact with, and test 2D/3D browser games from the terminal.")
    .version(packageVersion(), "-v, --version")
    .showHelpAfterError()
    .exitOverride();

  program
    .option("--project <dir>", "game project root (default: the current directory)")
    .option("--json", "emit one machine-readable result envelope on stdout")
    .option("--debug", "print stack traces and internal diagnostics");

  withGlobals(program.command("init"))
    .description("create or refresh the .gameprob/ project workspace (never overwrites your files)")
    .option("--link-agents", "append one GameProb reference to the project root AGENTS.md")
    .action(async function (this: Command, options: { linkAgents?: boolean }) {
      await execute("init", this, () => {
        const result = runInit({
          ...pickProject(this),
          linkAgents: options.linkAgents === true,
        });
        return { data: result, warnings: [] } satisfies CommandResult<typeof result>;
      });
    });

  withGlobals(program.command("open"))
    .description("launch the browser and navigate to the game (starts a session)")
    .argument("[url]", "game URL; defaults to config game.url")
    .option("--headed", "show the browser window (only before the browser launches)")
    .option("--allow-remote", "explicitly permit a non-loopback target")
    .action(async function (
      this: Command,
      url: string | undefined,
      options: { headed?: boolean; allowRemote?: boolean },
    ) {
      await execute("open", this, () =>
        runOpen(url, {
          ...pickProject(this),
          headed: options.headed === true,
          allowRemote: options.allowRemote === true,
        }),
      );
    });

  withGlobals(program.command("snapshot"))
    .description("list the scene tree with session-local @gN refs (requires the bridge)")
    .option("--depth <n>", "maximum traversal depth")
    .option("--limit <n>", "maximum number of objects to report")
    .option("--delta", "report only changes since the previous snapshot")
    .action(async function (
      this: Command,
      options: { depth?: string; limit?: string; delta?: boolean },
    ) {
      await execute("snapshot", this, () => runSnapshot({ ...pickProject(this), ...options }));
    });

  withGlobals(program.command("inspect"))
    .description("report facts about one object: transform, bounds, geometry, warnings")
    .argument("<selector>", "@gN ref, gameprob:id=<id>, name:<name>, or type:<type>")
    .option("--details", "include materials, textures, bones and renderer statistics")
    .action(async function (this: Command, selector: string, options: { details?: boolean }) {
      await execute("inspect", this, () =>
        runInspect(selector, { ...pickProject(this), details: options.details === true }),
      );
    });

  withGlobals(program.command("act"))
    .description("drive real browser input, or step a controllable simulation")
    .argument("<action>", "keydown | keyup | press | click | step")
    .argument("[args...]", "key name, x y coordinates, or tick count")
    .action(async function (this: Command, action: string, args: string[]) {
      await execute("act", this, () => runAct(action, args, pickProject(this)));
    });

  withGlobals(program.command("capture"))
    .description("save a page screenshot, or an object framed from several views")
    .argument("[selector]", "@gN ref or persistent selector for object capture")
    .option("--page", "capture the whole page (works without a bridge)")
    .option("--views <list>", "comma-separated views: front,back,left,right,top,bottom,current")
    .option("--out <path>", "output file (.png) or directory, relative to the project root")
    .option("--overwrite", "replace an existing file")
    .action(async function (
      this: Command,
      selector: string | undefined,
      options: { page?: boolean; views?: string; out?: string; overwrite?: boolean },
    ) {
      await execute("capture", this, () =>
        runCapture(selector, { ...pickProject(this), ...options }),
      );
    });

  withGlobals(program.command("run"))
    .description("execute .gameprob/tests/**/*.spec.ts with Playwright Test")
    .argument("[spec]", "a spec file or directory; defaults to .gameprob/tests")
    .option("--workers <n>", "parallel workers (default 1 for GPU predictability)")
    .action(async function (
      this: Command,
      spec: string | undefined,
      options: { workers?: string },
    ) {
      await execute("run", this, () => runTests(spec, { ...pickProject(this), ...options }));
    });

  withGlobals(program.command("close"))
    .description("close the browser session and stop this project's daemon")
    .action(async function (this: Command) {
      await execute("close", this, () => runClose(pickProject(this)));
    });

  const skills = program
    .command("skills")
    .description("print documentation for the installed version");
  withGlobals(skills.command("get"))
    .description("print a bundled guide")
    .argument("<name>", "guide name (core)")
    .option("--full", "include the reference and troubleshooting sections")
    .action(async function (this: Command, name: string, options: { full?: boolean }) {
      await execute("skills", this, () => {
        if (name !== "core") {
          throw new GameProbError({
            code: "INVALID_ARGUMENT",
            message: `Unknown guide "${name}".`,
            hint: "Available guides: core. Run `gameprob skills get core`.",
          });
        }
        const result = runSkillsGetCore({ full: options.full === true });
        return {
          data: { content: result.content, version: result.version, full: result.full },
          warnings: [],
        } satisfies CommandResult<{ content: string; version: string; full: boolean }>;
      });
    });

  return program;
}

/**
 * Global flags are declared on every subcommand as well, so they work both
 * before and after the command name: `gameprob --json open` and `gameprob open --json`.
 */
function withGlobals(command: Command): Command {
  return command
    .option("--project <dir>", "game project root (default: the current directory)")
    .option("--json", "emit one machine-readable result envelope on stdout")
    .option("--debug", "print stack traces and internal diagnostics");
}

function pickProject(command: Command): { project?: string } {
  const globals = mergeGlobals(command);
  return globals.project ? { project: globals.project } : {};
}

function mergeGlobals(command: Command): GlobalOptions {
  // Walk to the root so `gameprob --json skills get core` works too.
  const chain: Command[] = [];
  let current: Command | undefined = command;
  while (current) {
    chain.unshift(current);
    current = current.parent ?? undefined;
  }
  const merged: Record<string, unknown> = {};
  for (const entry of chain) {
    for (const [key, value] of Object.entries(entry.opts() as Record<string, unknown>)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as GlobalOptions;
}

async function execute<T>(
  name: string,
  command: Command,
  handler: () => CommandResult<T> | Promise<CommandResult<T>>,
): Promise<void> {
  const globals = mergeGlobals(command);
  const output = new Output({ json: globals.json === true, debug: globals.debug === true });
  try {
    const result = await handler();
    output.success(name, result.data, result.warnings, {
      json: output.json,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    });
  } catch (error) {
    process.exitCode = output.failure(name, toGameProbError(error));
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  try {
    await buildProgram().parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      const benign =
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help";
      if (!benign) process.exitCode = EXIT_CODES.INVALID_ARGUMENT;
      return;
    }
    throw error;
  }
}

/**
 * Was this file the program Node was asked to run?
 *
 * A package binary is a symlink (`node_modules/.bin/gameprob`), and ESM resolves
 * `import.meta.url` to the *real* path, so the two must be compared as real
 * paths — otherwise `npx gameprob` would silently do nothing and exit 0.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await main();
}
