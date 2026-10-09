<!-- agent-playtest-template-version: 1 -->
# Agent Playtest QA Progress

Keep this short and factual. Separate what was observed from what is assumed.

## Project facts (verified)

- Engine: Three.js (bridge reports `three`; import map points at
  `/vendor/three/three.module.js`).
- Main scene: `spinner-scene`, depth 4, 7 objects:
  `@g1` scene, `@g2` AmbientLight, `@g3` DirectionalLight, `@g4` floor,
  `@g5` Hero `[agent-playtest:id=main-hero]`, `@g6` Wall `[agent-playtest:id=wall]`,
  `@g7` Obstacle `[agent-playtest:id=obstacle]`.
- Hero bounds: size `[1.126412, 0.8, 1.126412]`, world position
  `[0, 0.4, 0]` at rest.
- Wall rule: `MAX_HERO_X = WALL_INNER_X - HERO_HALF_WIDTH = 1.92 - 0.4 = 1.52`.
  Verified: `keydown ArrowRight` + `step 240` (dt = 1/60) moves the hero to
  `x = 1.52` exactly and stops there; `state()` reports `touchesWall: true`.
- Capabilities advertised: `capture.object`, `capture.page`, `input.keyboard`,
  `input.pointer`, `scene.inspect`, `scene.snapshot`, `simulation.action`,
  `simulation.pause`, `simulation.reset`, `simulation.state`, `simulation.step`.

## Warnings the bridge reported (verified, not assumed)

- Animation clips exist but `renderer.info` per-render counters are reset every
  frame, so frame-level render statistics are not trustworthy here.
- `SkinnedMesh` bounds are bind-pose only; animated bounds may differ.
- Snapshot `checks.scope` warns when the traversal window is smaller than the
  scene, so a truncated tree is never mistaken for the whole scene.

## Tests

- [x] Startup loads successfully (`gameReady: true`, bridge connected).
- [x] Character object discovered by `agent-playtest:id=main-hero`.
- [x] Wall collision: hero clamps at `x = 1.52` after 240 ticks (see
      `.agent-playtest/tests/spinner.spec.ts`).
- [x] Object capture: hero framed from `front` and `right`, both non-blank.
- [x] Page capture: 960x540, non-blank.

## Open issues

None. Bug records live in `.agent-playtest/bugs/` as `GP-0001.md` and use the
observation / evidence / reproduction / hypotheses / verification structure.

## Current blockers

None for the browser flow. `capture` requires a Chromium that can render WebGL;
on musl/Alpine install `chromium-swiftshader` and set
`AGENT_PLAYTEST_CHROMIUM_PATH=/usr/bin/chromium`.

## Next actions

1. Run `agent-playtest run` after any gameplay change; the three specs in
   `.agent-playtest/tests/` cover startup, the collision rule and capture.
2. Add a spec for the obstacle's collision box once its rule is decided.
3. Keep `@gN` refs out of saved specs — use `agent-playtest:id=...` selectors, which
   survive reloads.
