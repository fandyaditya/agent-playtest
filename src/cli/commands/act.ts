/**
 * `gameprob act <keydown|keyup|press|click|step> [args]`
 */

import { GameProbError } from "../../shared/errors.ts";
import type { ActionResult } from "../../shared/types.ts";
import { type CommandResult, callDaemon, loadContext } from "../context.ts";

export interface ActCommandOptions {
  project?: string;
}

const ACTIONS = new Set(["keydown", "keyup", "press", "click", "step"]);

export async function runAct(
  action: string | undefined,
  args: string[],
  options: ActCommandOptions,
): Promise<CommandResult<ActionResult>> {
  if (!action || !ACTIONS.has(action)) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message: `act requires one of: keydown, keyup, press, click, step (received ${JSON.stringify(action ?? "")}).`,
      hint: "Examples: gameprob act keydown ArrowRight | gameprob act click 400 280 | gameprob act step 120",
    });
  }
  const context = loadContext({ project: options.project, requireWorkspace: true });

  const params: Record<string, unknown> = { action };
  if (action === "keydown" || action === "keyup" || action === "press") {
    if (args.length !== 1) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: `act ${action} takes exactly one key argument.`,
      });
    }
    params.key = args[0];
  } else if (action === "click") {
    if (args.length !== 2) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: "act click takes exactly two viewport CSS pixel coordinates: x y.",
      });
    }
    const x = Number(args[0]);
    const y = Number(args[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: `act click needs numeric coordinates (received ${JSON.stringify(args)}).`,
        hint: "Example: gameprob act click 400 280",
      });
    }
    params.x = x;
    params.y = y;
  } else {
    if (args.length !== 1) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: "act step takes exactly one tick count.",
      });
    }
    const ticks = Number(args[0]);
    if (!Number.isInteger(ticks) || ticks <= 0) {
      throw new GameProbError({
        code: "INVALID_ARGUMENT",
        message: `act step needs a positive whole number of ticks (received ${JSON.stringify(args[0])}).`,
        hint: "Example: gameprob act step 120",
      });
    }
    params.ticks = ticks;
  }

  return callDaemon<ActionResult>(context, "act", params, { requireSession: true });
}
