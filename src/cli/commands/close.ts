/**
 * `gameprob close`
 *
 * Never starts a daemon: if there is no session, it reports that honestly.
 */

import { type CommandResult, callDaemon, existingSession, loadContext } from "../context.ts";

export interface CloseCommandOptions {
  project?: string;
}

export interface CloseResult {
  closed: boolean;
  sessionId?: string;
  alreadyClosed?: boolean;
}

export async function runClose(options: CloseCommandOptions): Promise<CommandResult<CloseResult>> {
  const context = loadContext({ project: options.project });
  const handle = await existingSession(context);
  if (!handle) {
    return { data: { closed: true, alreadyClosed: true }, warnings: [] };
  }
  return callDaemon<CloseResult>(context, "close", {}, { timeoutMs: 60_000 });
}
