# Agent Playtest reference (v{{VERSION}})

This is the `--full` companion to `agent-playtest skills get core`. It documents the
JSON envelope, capabilities, the bridge contract and troubleshooting.

## JSON envelope

Every `--json` result uses one stable shape:

```json
{
  "protocolVersion": 1,
  "ok": true,
  "command": "inspect",
  "sessionId": "s_7c1b",
  "data": { "ref": "@g2", "name": "Hero", "kind": "skinnedMesh", "worldPosition": [0, 0, 0] },
  "warnings": [],
  "durationMs": 13
}
```

Failures keep the same outer shape with `ok: false` and an `error` object:

```json
{
  "protocolVersion": 1,
  "ok": false,
  "command": "act",
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "Controlled simulation is not connected for this project.",
    "missing": ["simulation.pause", "simulation.step"],
    "hint": "Ask the coding agent to add the optional simulation hooks in .agent-playtest/bridge.ts."
  },
  "warnings": [],
  "durationMs": 0
}
```

Branch on `error.code`, never on message text. Exit codes are listed in the core
guide and are part of the public contract.

## Capability keys

```
scene.snapshot      scene.inspect       capture.page        capture.object
input.keyboard      input.pointer       animations.inspect
simulation.pause    simulation.step     simulation.reset
simulation.state    simulation.action   physics.inspectBody physics.contacts
```

Capabilities are **observed**, never inferred from a dependency. `capture.page`,
`input.keyboard` and `input.pointer` come from the browser driver; the rest come
from the connected bridge and are reported with a `sources` map.

## Interaction tiers

| Tier | Requires | Enables |
|---|---|---|
| A — browser-only | nothing | `open`, `capture --page`, `act keydown/keyup/press/click`, console errors |
| B — read-only bridge | `scene`, `camera`, `renderer` | `snapshot`, `inspect`, refs, structural warnings, object capture |
| C — controllable bridge | optional `simulation` / `physics` hooks | `act step`, reset/state/action, state-based collision assertions |

Operations outside the current tier return `CAPABILITY_UNAVAILABLE` with the
missing hook names.

## Bridge contract (`agent-playtest/bridge`)

```ts
import { connect } from "agent-playtest/bridge";

connect({
  engine: "three",
  scene, camera, renderer,
  subjects: { hero: { object: heroRoot, id: "main-hero", forward: [0, 0, -1], up: [0, 1, 0] } },
  simulation: { pause, step, reset, state, action },   // optional
  physics: { inspectBody, contacts },                  // optional
  ready: () => gameIsReady,                            // optional
});
```

- Must be called in the browser, from a **development-only** code path.
- Registers `window.__AGENT_PLAYTEST_BRIDGE__`; re-registering disposes the previous
  connection (safe under HMR).
- Never mutates game state permanently. Object capture clones the camera and
  restores `renderer.render` in a `finally` block.
- `?agent-playtest=1` is not a security boundary: verify the production build excludes
  the bridge.

Give important objects a stable identity so saved tests do not depend on
session-local refs:

```ts
heroRoot.userData.agentPlaytest = { id: "main-hero", role: "character" };
```

## Configuration

`.agent-playtest/config.json` (schema version 1):

```json
{
  "schemaVersion": 1,
  "project": { "name": "my-game", "engineHint": "three" },
  "game": { "url": "http://127.0.0.1:5173/?agent-playtest=1" },
  "browser": {
    "headless": true,
    "backend": "chromium-shell",
    "viewport": { "width": 960, "height": 540 },
    "deviceScaleFactor": 1
  },
  "session": { "idleTimeoutMs": 1800000 },
  "output": { "directory": ".agent-playtest/output" }
}
```

Precedence: explicit flags > project config > `~/.agent-playtest/config.json` > built-in
defaults. Unknown keys and invalid values are rejected with a diagnostic; schema
versions are never migrated silently.

`chromium-shell` is Playwright's default headless shell. `chromium` selects the
full browser (new headless), which renders WebGL differently — never compare
screenshot baselines across backends.

## Evidence layout

```
.agent-playtest/output/<run-id>/
├── result.json
├── screenshots/            (or capture-<timestamp>/ with PNGs + manifest)
├── logs/browser-console.jsonl
└── traces/                 (when enabled)
```

Reference artifacts by relative project path or run ID, never by an absolute
machine-local path.

## Troubleshooting

**`BROWSER_LAUNCH_FAILED`** — install the browser once:

```bash
npx playwright install --only-shell chromium
```

**`BRIDGE_NOT_CONNECTED`** — the page loaded without a bridge. Check that the
development-only `connect()` call actually runs, that the URL carries
`?agent-playtest=1`, and that the dev server was restarted after editing the source.

**`CAPABILITY_UNAVAILABLE` with `simulation.*`** — the project has not exposed
`pause`/`step`. Agent Playtest will not pretend to run a controlled simulation; use
real browser input and describe the limitation instead.

**`STALE_REF`** — the page navigated, reloaded or replaced its scene. Run
`agent-playtest snapshot` again, and use `agent-playtest:id=<id>` selectors in saved tests.

**`IPC_PROTOCOL_MISMATCH`** — a daemon from a different Agent Playtest version is
running. `agent-playtest close` (or reinstall) starts a version-matched daemon.

**Object capture looks wrong or blank** — confirm the subject has measurable
geometry (`inspect --details`), that it is visible, and that the renderer is a
`WebGLRenderer`. Blank frames are reported as failures on purpose.

**The daemon is not responding** — logs live in `~/.agent-playtest/logs/`, session
metadata in `~/.agent-playtest/sessions/`. `agent-playtest close` is always safe.

## Performance expectations

A persistent daemon removes per-command browser startup, and `snapshot`/`inspect`
answer structural questions without screenshots. Controlled simulation can skip
intermediate render frames — that reduces **rendered frames**, not total runtime
by the same factor. Never claim a fixed speedup: startup, simulation work,
collision solving, GPU synchronization and screenshots still cost time.

## Not in V1

A built-in autonomous agent, MCP server, cloud rendering, a dashboard, a project
database, a universal fixture DSL, a physics engine, and non-Three.js adapters
(Phaser is planned). Anything unfinished is reported as unavailable rather than
exposed as a silently inert command.
