# Example game: spinner

A minimal but real Three.js game, used to exercise Agent Playtest end to end: the
scene graph, persistent selectors, deterministic stepping, object capture and a
regression test for a real gameplay rule (the wall stops the hero at
`x = 1.52`).

## Run it

```bash
pnpm install
pnpm build              # produces dist/, which the example server serves
pnpm --filter agent-playtest-example-spinner start
# → http://127.0.0.1:5199/?agent-playtest=1
```

The server is a plain Node static server — no bundler — so `three` and the
bridge are served straight from the repository:

- `/vendor/three/*` → `node_modules/three/build/*`
- `/vendor/agent-playtest/*` → `dist/*`

Because there is no bundler, the development-only bridge call lives inline in
`main.js` rather than in `.agent-playtest/bridge.ts`. `?agent-playtest=1` is **not** a
security boundary: a real project must gate the bridge behind its bundler's
dev-only condition and verify the production build excludes it.

## Drive it with Agent Playtest

```bash
agent-playtest --project examples/spinner open
agent-playtest --project examples/spinner snapshot
agent-playtest --project examples/spinner inspect agent-playtest:id=main-hero
agent-playtest --project examples/spinner act keydown ArrowRight
agent-playtest --project examples/spinner act step 240
agent-playtest --project examples/spinner inspect agent-playtest:id=main-hero
agent-playtest --project examples/spinner capture agent-playtest:id=main-hero --views front,right
agent-playtest --project examples/spinner run
agent-playtest --project examples/spinner close
```

## What it demonstrates

| Agent Playtest feature | Where |
|---|---|
| Persistent selectors | `hero.userData.agentPlaytest.id = "main-hero"` |
| Scene traversal and inspection | floor, hero, wall, obstacle meshes |
| Real browser input | `ArrowRight`/`ArrowLeft` key handlers |
| Controlled simulation | `simulation.pause/step/reset/state/action` hooks |
| Object capture | `capture agent-playtest:id=main-hero --views front,right` |
| Durable regression tests | `.agent-playtest/tests/spinner.spec.ts` |
