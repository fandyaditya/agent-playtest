/**
 * `gameprob inspect <@ref|selector> [--details]`
 */

import { GameProbError } from "../../shared/errors.ts";
import type { InspectResult } from "../../shared/types.ts";
import { type CommandResult, callDaemon, loadContext } from "../context.ts";

export interface InspectCommandOptions {
  project?: string;
  details?: boolean;
}

export async function runInspect(
  selector: string | undefined,
  options: InspectCommandOptions,
): Promise<CommandResult<InspectResult>> {
  if (!selector) {
    throw new GameProbError({
      code: "INVALID_ARGUMENT",
      message:
        "inspect requires a subject: a @gN ref from `gameprob snapshot`, or a persistent selector such as gameprob:id=main-hero.",
    });
  }
  const context = loadContext({ project: options.project, requireWorkspace: true });
  return callDaemon<InspectResult>(
    context,
    "inspect",
    {
      selector,
      details: options.details === true,
    },
    { requireSession: true },
  );
}
