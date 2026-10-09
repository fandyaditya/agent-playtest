/**
 * `agent-playtest snapshot [--depth N] [--delta]`
 */

import type { SnapshotResult } from "../../shared/types.ts";
import { type CommandResult, callDaemon, loadContext } from "../context.ts";

export interface SnapshotCommandOptions {
  project?: string;
  depth?: string;
  limit?: string;
  delta?: boolean;
}

export async function runSnapshot(
  options: SnapshotCommandOptions,
): Promise<CommandResult<SnapshotResult>> {
  const context = loadContext({ project: options.project, requireWorkspace: true });
  const params: Record<string, unknown> = {};
  if (options.depth !== undefined) params.depth = Number(options.depth);
  if (options.limit !== undefined) params.limit = Number(options.limit);
  if (options.delta) params.delta = true;
  // A read command must never start a daemon just to be told there is no
  // session: `existingSession` keeps the failure immediate and honest.
  return callDaemon<SnapshotResult>(context, "snapshot", params, { requireSession: true });
}
