---
name: agent-playtest
description: Inspect and test 2D/3D browser games with a local CLI. Use for Three.js/Phaser scenes, characters, collisions, animation, screenshots, gameplay state, and regression tests.
---

# Agent Playtest

A local browser-game inspection and testing CLI for coding agents.

## Start here

Read the version-matched instructions from the installed CLI:

```bash
agent-playtest skills get core
```

For a new project:

```bash
agent-playtest init
```

Read `.agent-playtest/AGENTS.md` when it exists.

## Typical workflow

```bash
agent-playtest open http://127.0.0.1:5173/?agent-playtest=1
agent-playtest snapshot
agent-playtest inspect @g1
agent-playtest capture @g1
agent-playtest run
agent-playtest close
```

Keep reusable tests in `.agent-playtest/tests/` and report only verified findings.
