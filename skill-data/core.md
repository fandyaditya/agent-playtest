# GameProb core guide (v{{VERSION}})

GameProb is a **local CLI** for inspecting, interacting with and testing 2D/3D
browser games. It is used *by* coding agents: GameProb contains no AI model, no
cloud service and no autonomous loop.

- Machine runtime: `~/.gameprob/` (sessions, logs)
- Project workspace: `<project>/.gameprob/` (config, bridge, tests, bugs, progress)
- Scene refs: `@g1`, `@g2`, … — session-local, never durable test identifiers

Run `gameprob skills get core --full` for the reference and troubleshooting
sections.

## Start here

```bash
gameprob init                     # create/refresh the project workspace
gameprob skills get core          # this guide, for the installed version
gameprob open http://127.0.0.1:5173/?gameprob=1
gameprob snapshot
gameprob inspect @g1
gameprob capture @g1 --views front,back,left,right
gameprob run                      # run .gameprob/tests/**/*.spec.ts
gameprob close
```

Read `.gameprob/AGENTS.md` when it exists: it describes this project's
integration and where tests, bugs and progress notes belong.

## Commands

```
gameprob init [--project <dir>] [--link-agents]
gameprob open [url] [--headed] [--allow-remote] [--json]
gameprob snapshot [--depth N] [--limit N] [--delta] [--json]
gameprob inspect <@ref|selector> [--details] [--json]
gameprob act <keydown|keyup|press|click|step> [args] [--json]
gameprob capture [@ref|selector] [--page] [--views ...] [--out <path>] [--overwrite] [--json]
gameprob run [spec-or-directory] [--workers N] [--json]
gameprob close [--json]
gameprob skills get core [--full]
```

`--json` prints one stable envelope on stdout for every data-returning command.
Without it, human text goes to stdout and warnings/diagnostics to stderr.

### init

Idempotent and non-destructive. Creates `.gameprob/{AGENTS.md,config.json,bridge.ts,progress.md,.gitignore}`
plus `tests/` and `bugs/`. It never edits game source, never overwrites your
files, and never runs package scripts. `--link-agents` appends one short
reference to the project root `AGENTS.md` (only if it is not already there).

### open

Resolves the URL argument or `config.game.url`, then starts or reuses the
project daemon and Chromium. Only loopback targets (`localhost`, `127.0.0.0/8`,
`::1`) are allowed unless you pass `--allow-remote`.

The result reports the browser backend, whether a bridge was detected, the
observed capability map, and readiness. `DOMContentLoaded` is **not** evidence
that game assets finished loading; game readiness is `unknown` unless the bridge
advertises a `ready()` probe.

### snapshot

Returns a bounded scene tree with `@gN` refs, names, kinds, positions, child
counts and structural warnings. Truncation is always reported (`truncated`,
`objectsShown` of `objectsTotal`) — never silent. `--delta` compares against the
previous snapshot of the same session; if there is no baseline it returns a full
snapshot with `mode: "full"`.

Without a bridge, `snapshot` fails with `CAPABILITY_UNAVAILABLE`. GameProb will
not fabricate a scene tree from the DOM.

### inspect

`inspect @g1` returns identifying facts, transforms, bounds, geometry/material
summaries, parent/children and warnings. `--details` adds attribute lists,
texture summaries, bone names and renderer statistics.

Selectors, in order of preference:

1. `gameprob:id=main-hero` — persistent; comes from `object.userData.gameprob.id`
2. `name:Hero` — only when the name is unique
3. `type:SkinnedMesh` — first match, with a warning
4. `@g1` — session-local; **never** use it in a saved test

Stale refs fail with `STALE_REF`; run `snapshot` again.

### act

```bash
gameprob act keydown ArrowRight
gameprob act keyup ArrowRight
gameprob act press Space
gameprob act click 400 280
gameprob act step 120
```

`keydown`/`keyup`/`press`/`click` are real Playwright browser input; `click`
uses viewport CSS pixel coordinates. `step 120` is **not** browser input: it
requires the project to have registered `simulation.pause` and `simulation.step`
hooks. One `act step` makes one IPC call and loops in-page; without the hooks it
fails with `CAPABILITY_UNAVAILABLE` listing exactly what is missing.

### capture

```bash
gameprob capture --page --out .gameprob/output/page.png
gameprob capture @g2 --out .gameprob/output/hero.png
gameprob capture @g2 --views front,back,left,right
```

Page capture works without a bridge. Object capture requires scene, camera and
renderer. Views are framed from the subject's world bounds; the game camera is
cloned, so game state is restored afterwards. A uniform (blank) frame is
reported as a failure, not a success. Multi-view captures write a manifest JSON
next to the PNGs. `--overwrite` is required to replace an existing file.

### run

Executes `.gameprob/tests/**/*.spec.ts` with Playwright Test in **isolated
contexts** — never in the daemon's interactive page. Default `workers=1` for GPU
predictability. Evidence goes to `.gameprob/output/<run-id>/`. A failing
assertion, no matching tests, or an unrunnable configuration all exit non-zero.
`run` never calls an AI model.

## Writing a test

```ts
import { test, expect } from "gameprob/test";

test("hero is discoverable", async ({ game }) => {
  const snapshot = await game.snapshot();
  const hero = snapshot.objects.find((o) => o.selector === "gameprob:id=main-hero");
  expect(hero).toBeDefined();

  const inspected = await game.inspect("gameprob:id=main-hero");
  expect(inspected.visible).toBe(true);

  await game.capture({ selector: "gameprob:id=main-hero", name: "hero-front" });
});
```

The `game` fixture exposes `open`, `snapshot`, `inspect`, `act`, `capture`,
`capabilities`, `reset`, `step`, `state`, `action` and the underlying `page`.
Capability-dependent methods (`reset`, `step`, `state`, `action`) throw a typed
`CAPABILITY_UNAVAILABLE` error when the project has not registered the hooks.

## Error codes

| Code | Exit | Meaning |
|---|---|---|
| `INVALID_ARGUMENT` | 2 | Flag or argument invalid |
| `CONFIG_INVALID` | 2 | Config parse/validation failure |
| `PROJECT_NOT_INITIALIZED` | 2 | Missing `.gameprob/` workspace |
| `SESSION_NOT_FOUND` | 3 | No active browser session |
| `BROWSER_LAUNCH_FAILED` | 3 | Chromium could not launch |
| `NAVIGATION_FAILED` | 3 | Navigation/timeout |
| `BRIDGE_NOT_CONNECTED` | 4 | Required bridge missing |
| `CAPABILITY_UNAVAILABLE` | 4 | Requested feature not connected |
| `OBJECT_NOT_FOUND` | 4 | Selector not found |
| `STALE_REF` | 4 | Ref invalidated by reload/reset |
| `TEST_FAILED` | 5 | One or more assertions failed |
| `TEST_SETUP_FAILED` | 5 | Test tooling/config cannot run |
| `UNAUTHORIZED_TARGET` | 6 | Origin/path denied by safety rules |
| `IPC_PROTOCOL_MISMATCH` | 7 | Incompatible daemon/CLI versions |
| `INTERNAL_ERROR` | 1 | Unexpected internal defect |

Exit 0 means the command succeeded — **not** that the game has no bugs.

## Honesty rules

- Never mark an unsupported check as passed. A test that cannot run is
  `unsupported` or `setup failed`.
- Bounding-box overlap is not proof of a physics collision.
- A screenshot difference is a regression signal, not automatically a design bug.
- Keep raw observations, expectations, assertion outcomes, hypotheses and
  verified fixes separate in every bug record.
- Never change game logic just to make an assertion pass.
