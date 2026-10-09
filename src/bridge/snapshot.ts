/**
 * Scene snapshots, object summaries, structural warnings and deltas.
 *
 * Deterministic order: hierarchy pre-order; limits are applied after sorting so
 * equal inputs always produce equal output.
 */

import type {
  GameObjectSummary,
  SnapshotOptions,
  SnapshotResult,
  SnapshotWarning,
} from "../shared/types.ts";
import type { EngineAdapter } from "./adapter.ts";
import type { RefRegistry } from "./registry.ts";

export interface SnapshotState {
  revision: number;
  lastFingerprints: Map<string, string> | null;
}

export const DEFAULT_SNAPSHOT_DEPTH = 4;
export const DEFAULT_SNAPSHOT_LIMIT = 200;

export function createSnapshotState(): SnapshotState {
  return { revision: 0, lastFingerprints: null };
}

export function resetSnapshotState(state: SnapshotState): void {
  state.lastFingerprints = null;
}

function fingerprint(summary: GameObjectSummary): string {
  return [
    summary.kind,
    summary.engineType,
    summary.name,
    summary.visible === undefined ? "?" : String(summary.visible),
    summary.position ? summary.position.join(",") : "-",
    summary.childCount === undefined ? "-" : String(summary.childCount),
    summary.animation ?? "-",
    summary.parentRef ?? "-",
    summary.selector ?? "-",
  ].join("|");
}

export function buildSnapshot<T>(
  adapter: EngineAdapter<T>,
  registry: RefRegistry,
  state: SnapshotState,
  options: SnapshotOptions,
): SnapshotResult {
  const depth = options.depth ?? DEFAULT_SNAPSHOT_DEPTH;
  const limit = options.limit ?? DEFAULT_SNAPSHOT_LIMIT;

  const traversal = adapter.traverse({ depth, limit });
  const refs = new Map<T, string>();
  const seen = new Set<string>();
  const summaries: GameObjectSummary[] = [];
  const warnings: SnapshotWarning[] = [];

  for (const entry of traversal.entries) {
    const ref = registry.refFor(entry.object as object);
    refs.set(entry.object, ref);
    seen.add(ref);
  }

  for (const entry of traversal.entries) {
    const ref = refs.get(entry.object) as string;
    const parentRef = entry.parent ? refs.get(entry.parent) : undefined;
    const summary = adapter.summary(entry.object, ref, parentRef);
    summaries.push(summary);
    warnings.push(...adapter.quickWarnings(entry.object, ref));
  }

  registry.prune(seen);

  warnings.push(
    ...duplicateIdWarnings(
      adapter,
      traversal.entries.map((entry) => entry.object),
    ),
  );

  state.revision += 1;
  const revision = state.revision;

  const currentFingerprints = new Map<string, string>();
  for (const summary of summaries) currentFingerprints.set(summary.ref, fingerprint(summary));

  let delta: SnapshotResult["delta"];
  let mode: "full" | "delta" = "full";
  let baseRevision: number | undefined;

  if (options.delta && state.lastFingerprints) {
    mode = "delta";
    baseRevision = revision - 1;
    const previous = state.lastFingerprints;
    const added: GameObjectSummary[] = [];
    const updated: GameObjectSummary[] = [];
    const removed: string[] = [];
    for (const summary of summaries) {
      const before = previous.get(summary.ref);
      if (before === undefined) added.push(summary);
      else if (before !== currentFingerprints.get(summary.ref)) updated.push(summary);
    }
    for (const ref of previous.keys()) {
      if (!currentFingerprints.has(ref)) removed.push(ref);
    }
    removed.sort((a, b) => refNumber(a) - refNumber(b));
    delta = { added, updated, removed };
  }

  state.lastFingerprints = currentFingerprints;

  if (traversal.truncated) {
    warnings.push({
      check: "snapshot.limited",
      confidence: "high",
      message: `Snapshot shows ${summaries.length} of ${traversal.total} objects at depth ${depth}. Re-run with --depth/--limit for more, or use selectors to target specific objects.`,
    });
  }
  warnings.push({
    check: "checks.scope",
    confidence: "high",
    message: `Structural checks ran on the ${summaries.length} object(s) shown. Zero warnings is not proof that the scene has no defects.`,
  });

  return {
    meta: {
      mode,
      engine: adapter.engine,
      ...(adapter.sceneName() ? { sceneName: adapter.sceneName() } : {}),
      revision,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      depth,
      objectLimit: limit,
      objectsShown: summaries.length,
      objectsTotal: traversal.total,
      truncated: traversal.truncated,
    },
    objects: summaries,
    ...(delta ? { delta } : {}),
    warnings,
  };
}

function refNumber(ref: string): number {
  const value = Number(ref.replace(/^@g/, ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function duplicateIdWarnings<T>(adapter: EngineAdapter<T>, objects: T[]): SnapshotWarning[] {
  const byId = new Map<string, T[]>();
  for (const object of objects) {
    const id = adapter.persistentIdOf(object);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(object);
    byId.set(id, list);
  }
  const warnings: SnapshotWarning[] = [];
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    warnings.push({
      check: "selector.duplicate-id",
      confidence: "high",
      message: `agent-playtest.id "${id}" is used by ${list.length} objects; selectors using it are ambiguous. Give exactly one object this id.`,
    });
  }
  return warnings;
}
