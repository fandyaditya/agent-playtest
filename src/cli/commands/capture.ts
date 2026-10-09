/**
 * `agent-playtest capture [@ref|selector] [--page] [--views ...] [--out path]`
 */

import { AgentPlaytestError } from "../../shared/errors.ts";
import type { CaptureResult, CaptureViewName } from "../../shared/types.ts";
import { type CommandResult, callDaemon, loadContext } from "../context.ts";

export interface CaptureCommandOptions {
  project?: string;
  page?: boolean;
  views?: string;
  out?: string;
  overwrite?: boolean;
}

const VALID_VIEWS = new Set<CaptureViewName>([
  "front",
  "back",
  "left",
  "right",
  "top",
  "bottom",
  "current",
]);

export async function runCapture(
  selector: string | undefined,
  options: CaptureCommandOptions,
): Promise<CommandResult<CaptureResult>> {
  const context = loadContext({ project: options.project, requireWorkspace: true });
  const params: Record<string, unknown> = {};
  if (options.page) params.page = true;
  if (selector) params.selector = selector;
  if (options.out) params.out = options.out;
  if (options.overwrite) params.overwrite = true;

  if (options.views) {
    const views = options.views
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    for (const view of views) {
      if (!VALID_VIEWS.has(view as CaptureViewName)) {
        throw new AgentPlaytestError({
          code: "INVALID_ARGUMENT",
          message: `Unknown view "${view}".`,
          hint: `Supported views: ${[...VALID_VIEWS].join(", ")}`,
        });
      }
    }
    params.views = views;
  }

  if (!options.page && !selector) {
    throw new AgentPlaytestError({
      code: "INVALID_ARGUMENT",
      message: "capture needs either --page or a subject (a @gN ref or a persistent selector).",
      hint: "Examples: agent-playtest capture --page | agent-playtest capture @g2 --views front,back,left,right",
    });
  }

  return callDaemon<CaptureResult>(context, "capture", params, {
    timeoutMs: 180_000,
    requireSession: true,
  });
}
