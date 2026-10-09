---
name: gameprob
description: Inspect and test 2D/3D browser games with a local CLI. Use for Three.js/Phaser scenes, characters, collisions, animation, screenshots, gameplay state, and regression tests.
---

# GameProb

A local browser-game inspection and testing CLI for coding agents.

## Start here

Read the version-matched instructions from the installed CLI:

```bash
gameprob skills get core
```

For a new project:

```bash
gameprob init
```

Read `.gameprob/AGENTS.md` when it exists.

## Typical workflow

```bash
gameprob open http://127.0.0.1:5173/?gameprob=1
gameprob snapshot
gameprob inspect @g1
gameprob capture @g1
gameprob run
gameprob close
```

Keep reusable tests in `.gameprob/tests/` and report only verified findings.
