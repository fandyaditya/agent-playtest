/**
 * `agent-playtest open [url]`
 */

import type { OpenResult } from "../../shared/types.ts";
import { type CommandResult, callDaemon, loadContext } from "../context.ts";

export interface OpenCommandOptions {
  project?: string;
  headed?: boolean;
  allowRemote?: boolean;
}

export async function runOpen(
  url: string | undefined,
  options: OpenCommandOptions,
): Promise<CommandResult<OpenResult>> {
  const context = loadContext({ project: options.project, requireWorkspace: true });
  return callDaemon<OpenResult>(context, "open", {
    ...(url ? { url } : {}),
    allowRemote: options.allowRemote === true,
    ...(options.headed ? { headed: true } : {}),
  });
}
