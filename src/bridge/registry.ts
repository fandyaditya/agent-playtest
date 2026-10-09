/**
 * Ephemeral object refs (`@g1`, `@g2`, …) and persistent selector resolution.
 *
 * Refs are session/generation local and must never be used as long-term test
 * identifiers. Objects are held through `WeakRef`s so the registry cannot keep
 * a removed game object alive.
 */

import type { GameObjectKind } from "../shared/types.ts";

export interface RegistryEntry {
  ref: string;
  object: object;
}

export class RefRegistry {
  #byObject = new WeakMap<object, string>();
  #byRef = new Map<string, WeakRef<object>>();
  /** Every ref handed out in the current generation, including removed ones. */
  #known = new Set<string>();
  #counter = 0;
  generation = 1;

  refFor(object: object): string {
    const existing = this.#byObject.get(object);
    if (existing) return existing;
    this.#counter += 1;
    const ref = `@g${this.#counter}`;
    this.#byObject.set(object, ref);
    this.#byRef.set(ref, new WeakRef(object));
    this.#known.add(ref);
    return ref;
  }

  resolve(ref: string): object | undefined {
    const weak = this.#byRef.get(ref);
    if (!weak) return undefined;
    const object = weak.deref();
    if (!object) {
      this.#byRef.delete(ref);
      return undefined;
    }
    return object;
  }

  /** True when the ref existed in this generation but its object is gone. */
  isKnownButGone(ref: string): boolean {
    return this.#known.has(ref) && !this.#byRef.has(ref);
  }

  isKnown(ref: string): boolean {
    return this.#known.has(ref);
  }

  /** Drop refs that are unreachable or were not part of the latest traversal. */
  prune(seen: Set<string>): void {
    for (const [ref, weak] of this.#byRef) {
      if (!seen.has(ref) || weak.deref() === undefined) this.#byRef.delete(ref);
    }
  }

  nextGeneration(): void {
    this.#byObject = new WeakMap();
    this.#byRef.clear();
    this.#known.clear();
    this.#counter = 0;
    this.generation += 1;
  }

  get size(): number {
    return this.#byRef.size;
  }
}

const REF_PATTERN = /^@g(\d+)$/;

export function parseRef(value: string): number | null {
  const match = REF_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]);
}

export interface SelectorMatch<T> {
  object: T;
  warnings: string[];
}

export interface SelectorSource<T> {
  candidates: T[];
  idOf(object: T): string | undefined;
  nameOf(object: T): string;
  engineTypeOf(object: T): string;
}

export type SelectorResolution<T> =
  | { kind: "found"; object: T; warnings: string[] }
  | { kind: "ambiguous"; matches: string[]; message: string }
  | { kind: "missing"; message: string };

/**
 * Supported persistent selectors:
 * - `agent-playtest:id=<id>` — explicit, adapter-known identifier (preferred)
 * - `name:<name>` — best effort, only when unique
 * - `three:type:<Type>` / `type:<Type>` — all objects of one engine type
 */
export function resolveSelector<T>(
  selector: string,
  source: SelectorSource<T>,
): SelectorResolution<T> {
  const value = selector.trim();
  if (value.startsWith("agent-playtest:id=")) {
    const id = value.slice("agent-playtest:id=".length);
    const matches = source.candidates.filter((c) => source.idOf(c) === id);
    if (matches.length === 0)
      return { kind: "missing", message: `No object has agent-playtest.id "${id}".` };
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        matches: matches.map((m) => `${source.engineTypeOf(m)} "${source.nameOf(m)}"`),
        message: `Duplicate agent-playtest.id "${id}" — add a unique id to exactly one object.`,
      };
    }
    return { kind: "found", object: matches[0] as T, warnings: [] };
  }

  if (value.startsWith("name:")) {
    const name = value.slice("name:".length);
    const matches = source.candidates.filter((c) => source.nameOf(c) === name);
    if (matches.length === 0) return { kind: "missing", message: `No object is named "${name}".` };
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        matches: matches.map((m) => `${source.engineTypeOf(m)} "${source.nameOf(m)}"`),
        message: `Name "${name}" matches ${matches.length} objects; use agent-playtest:id=<id> instead.`,
      };
    }
    return { kind: "found", object: matches[0] as T, warnings: [] };
  }

  if (value.startsWith("type:") || value.startsWith("three:type:")) {
    const type = value.slice(value.indexOf("type:") + "type:".length);
    const matches = source.candidates.filter((c) => source.engineTypeOf(c) === type);
    if (matches.length === 0) return { kind: "missing", message: `No object has type "${type}".` };
    return {
      kind: "found",
      object: matches[0] as T,
      warnings: [
        `Selector "type:${type}" matched ${matches.length} object(s); using the first (traversal order is not a stable identity).`,
      ],
    };
  }

  return {
    kind: "missing",
    message: `Unrecognized selector "${selector}". Use @gN from a snapshot, "agent-playtest:id=<id>", "name:<name>" or "type:<Type>".`,
  };
}

export interface KindHint {
  kind: GameObjectKind;
  engineType: string;
}
