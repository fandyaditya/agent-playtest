// agent-playtest-template-version: 1
//
// Phaser variant of the project connector.
//
// NOTE: the Phaser adapter is planned, not shipped in V1. `connect()` accepts
// only `engine: "three"` today and returns CAPABILITY_UNAVAILABLE for anything
// else. Keep this file as the integration sketch for the second engine
// milestone; do not wire it up expecting it to work yet.

import { connect } from "agent-playtest/bridge";

export function connectGame(refs: { game: unknown }) {
  return connect({
    engine: "phaser",
    ...(refs as Record<string, unknown>),
  });
}
