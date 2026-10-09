# Example game: spinner

A minimal but real Three.js game, used to exercise GameProb end to end: the
scene graph, persistent selectors, deterministic stepping, object capture and a
regression test for a real gameplay rule (the wall stops the hero at
`x = 1.52`).

## Run it

```bash
pnpm install
pnpm build              # produces dist/, which the example server serves
pnpm --filter gameprob-example-spinner start
# → http://127.0.0.1:5199/?gameprob=1
```

The server is a plain Node static server — no bundler — so `three` and the
bridge are served straight from the repository:

- `/vendor/three/*` → `node_modules/three/build/*`
- `/vendor/gameprob/*` → `dist/*`

Because there is no bundler, the development-only bridge call lives inline in
`main.js` rather than in `.gameprob/bridge.ts`. `?gameprob=1` is **not** a
security boundary: a real project must gate the bridge behind its bundler's
dev-only condition and verify the production build excludes it.

## Drive it with GameProb

```bash
gameprob --project examples/spinner open
gameprob --project examples/spinner snapshot
gameprob --project examples/spinner inspect gameprob:id=main-hero
gameprob --project examples/spinner act keydown ArrowRight
gameprob --project examples/spinner act step 240
gameprob --project examples/spinner inspect gameprob:id=main-hero
gameprob --project examples/spinner capture gameprob:id=main-hero --views front,right
gameprob --project examples/spinner run
gameprob --project examples/spinner close
```

## What it demonstrates

| GameProb feature | Where |
|---|---|
| Persistent selectors | `hero.userData.gameprob.id = "main-hero"` |
| Scene traversal and inspection | floor, hero, wall, obstacle meshes |
| Real browser input | `ArrowRight`/`ArrowLeft` key handlers |
| Controlled simulation | `simulation.pause/step/reset/state/action` hooks |
| Object capture | `capture gameprob:id=main-hero --views front,right` |
| Durable regression tests | `.gameprob/tests/spinner.spec.ts` |
