// agent-playtest-template-version: 1
//
// Agent-maintained connector between this game and Agent Playtest.
//
// Replace the imports below with the *actual* module paths this project uses,
// then call `connectGame(...)` once, from the game's real initialization code,
// behind a development-only condition. See .agent-playtest/AGENTS.md.
//
// `connect()` must run in the browser and must never ship in production.

import { connect } from "agent-playtest/bridge";
import type * as THREE from "three";

export function connectGame(refs: {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
}) {
  return connect({
    engine: "three",
    scene: refs.scene,
    camera: refs.camera,
    renderer: refs.renderer,

    // Optional: give important objects a stable identity so tests can use
    // persistent selectors instead of session-local @gN refs.
    //
    //   heroRoot.userData.agentPlaytest = { id: "main-hero", role: "character" };
    //
    // subjects: {
    //   hero: {
    //     object: heroRoot,
    //     id: "main-hero",
    //     forward: [0, 0, -1],
    //     up: [0, 1, 0],
    //     animations: animationClips,
    //   },
    // },

    // Optional: controlled simulation. Only add these when the game can really
    // pause its normal loop and advance with a fixed timestep; Agent Playtest reports
    // them as unavailable otherwise instead of faking a result.
    //
    // simulation: {
    //   pause: () => game.pauseNormalLoop(),
    //   step: (dtSeconds) => game.update(dtSeconds),
    //   reset: async (fixture) => game.loadTestFixture(fixture),
    //   state: (subjectId) => game.getTestState(subjectId),
    //   action: (name, args) => game.dispatchTestAction(name, args),
    // },
  });
}
