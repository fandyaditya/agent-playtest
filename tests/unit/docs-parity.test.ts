import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../src/cli/index.ts";
import { EXIT_CODES } from "../../src/shared/errors.ts";
import { packageRoot } from "../../src/shared/paths.ts";

const CORE = readFileSync(join(packageRoot(), "skill-data", "core.md"), "utf8");
const REFERENCE = readFileSync(join(packageRoot(), "skill-data", "reference.md"), "utf8");
const SKILL = readFileSync(join(packageRoot(), "skills", "gameprob", "SKILL.md"), "utf8");

function fencedBlock(markdown: string, heading: string): string {
  const after = markdown.slice(markdown.indexOf(heading));
  const match = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!match?.[1]) throw new Error(`no fenced block found after ${heading}`);
  return match[1];
}

function collectOptions(command: Command): Set<string> {
  const flags = new Set<string>();
  for (const option of command.options) {
    for (const flag of option.flags.split(/[,\s|]+/)) {
      if (flag.startsWith("--")) flags.add(flag);
    }
  }
  for (const child of command.commands) {
    for (const flag of collectOptions(child)) flags.add(flag);
  }
  return flags;
}

/** Every documented `gameprob <cmd> …` line, with the flags it advertises. */
function documentedCommands(): Array<{ name: string; line: string; flags: string[] }> {
  const block = fencedBlock(CORE, "## Commands");
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("gameprob "))
    .map((line) => {
      const tokens = line.split(/\s+/);
      const name = tokens[1] ?? "";
      const flags = (line.match(/--[a-z][a-z-]*/g) ?? []).filter(
        (flag, index, all) => all.indexOf(flag) === index,
      );
      return { name, line, flags };
    });
}

describe("documented CLI surface matches the program", () => {
  const program = buildProgram();
  const documented = documentedCommands();

  it("documents every top-level command", () => {
    const implemented = program.commands.map((command) => command.name());
    for (const command of implemented) {
      expect(documented.map((entry) => entry.name)).toContain(command);
    }
  });

  it("does not document commands that do not exist", () => {
    const implemented = program.commands.map((command) => command.name());
    for (const entry of documented) {
      expect(implemented).toContain(entry.name);
    }
  });

  it.each(documentedCommands().map((entry) => [entry.line, entry] as const))(
    "the flags in `%s` are all real",
    (_line, entry) => {
      const command = program.commands.find((candidate) => candidate.name() === entry.name);
      expect(command).toBeDefined();
      const available = collectOptions(command as Command);
      for (const flag of entry.flags) {
        expect(available.has(flag)).toBe(true);
      }
    },
  );

  it("returns a program whose leaf commands all carry the global flags", () => {
    const leaves: Command[] = [];
    const walk = (command: Command) => {
      if (command.commands.length === 0) leaves.push(command);
      for (const child of command.commands) walk(child);
    };
    walk(program);

    expect(leaves.length).toBeGreaterThan(5);
    for (const command of leaves) {
      const flags = collectOptions(command);
      expect(flags.has("--project")).toBe(true);
      expect(flags.has("--json")).toBe(true);
    }
  });

  it("describes every command and option (no blank help text)", () => {
    for (const command of program.commands) {
      expect(command.description().length).toBeGreaterThan(10);
      for (const option of command.options) {
        expect(option.description.length).toBeGreaterThan(3);
      }
    }
  });
});

describe("documented error codes match the implementation", () => {
  const table = CORE.slice(CORE.indexOf("## Error codes"))
    .split("\n")
    .map((line) => line.match(/^\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      code: match[1] as string,
      exit: Number(match[2]),
      meaning: match[3] ?? "",
    }));

  it("documents every exit code the implementation can return", () => {
    expect(table.map((entry) => entry.code).sort()).toEqual(Object.keys(EXIT_CODES).sort());
  });

  it("agrees with the implementation about each exit class", () => {
    for (const entry of table) {
      expect(EXIT_CODES[entry.code as keyof typeof EXIT_CODES]).toBe(entry.exit);
    }
  });

  it("explains what each code means", () => {
    for (const entry of table) {
      expect(entry.meaning.length).toBeGreaterThan(5);
    }
  });
});

describe("the bundled guides stay honest", () => {
  it("does not promise an AI model, a cloud service or an autonomous loop", () => {
    expect(CORE).toContain("no AI model");
    expect(CORE).toContain("never calls an AI model");
  });

  it("states the ref lifetime rule the implementation enforces", () => {
    expect(CORE).toContain("@g1`, `@g2`");
    expect(CORE).toContain("STALE_REF");
  });

  it("keeps the selector preference order in the guide and in the reference", () => {
    for (const selector of ["gameprob:id=", "name:", "type:", "@g1"]) {
      expect(CORE).toContain(selector);
    }
    expect(REFERENCE.length).toBeGreaterThan(500);
  });

  it("points the skill file at the CLI itself instead of duplicating it", () => {
    expect(SKILL).toContain("gameprob skills get core");
  });
});
