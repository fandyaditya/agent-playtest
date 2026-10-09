# GameProb

A small, **local** CLI that lets a coding agent inspect, interact with and test
2D/3D browser games — and turn what it learns into durable, repeatable tests.

GameProb contains **no AI model, no cloud service and no autonomous loop**. Your
agent (Claude Code, Codex, Cursor, …) is the intelligence; GameProb is the
deterministic instrument it points at the game.

```bash
gameprob init                       # create the .gameprob/ project workspace
gameprob open http://127.0.0.1:5173/?gameprob=1
gameprob snapshot                   # bounded scene tree with @gN refs
gameprob inspect @g2                # transform, bounds, geometry, warnings
gameprob act keydown ArrowRight
gameprob act step 120               # deterministic ticks, not wall-clock waiting
gameprob capture @g2 --views front,right
gameprob run                        # execute .gameprob/tests/**/*.spec.ts
gameprob close
```

## Why

An agent that can only take screenshots is guessing. An agent that can read the
scene graph, ask where the hero actually is, drive real input, and then write a
Playwright test that reproduces the bug is doing engineering.

- **Deterministic**: every command prints one stable JSON envelope with `--json`.
- **Honest**: unsupported checks are reported as unsupported. A blank frame is a
  failure, not a screenshot. Truncation is always reported.
- **Local**: a per-project daemon on a Unix socket, a machine runtime under
  `~/.gameprob/`, project knowledge under `<project>/.gameprob/`.
- **Agent-shaped**: `gameprob skills get core` prints the guide for the installed
  version, so instructions never drift from the binary.

## Install

```bash
npm install --save-dev gameprob
npx playwright install chromium   # or point at a system browser, see below
```

Requires **Node 24+**. The package ships the CLI, the in-page bridge
(`gameprob/bridge`), the Playwright fixture (`gameprob/test`), the project
templates and the versioned guides.

## Getting a browser that can render WebGL

GameProb launches Chromium through Playwright.

- **Normal machines**: `npx playwright install chromium` is enough.
- **musl/Alpine containers** (Playwright's glibc bundles cannot run there):
  install the distro Chromium and point GameProb at it:

  ```bash
  apk add chromium chromium-swiftshader   # swiftshader is required for WebGL
  export GAMEPROB_CHROMIUM_PATH=/usr/bin/chromium
  ```

  `chromium-swiftshader` provides `libvk_swiftshader.so`; without it Chromium
  reports `{"webgl": false}` and object capture fails honestly.

`GAMEPROB_CHROMIUM_PATH` (env) outranks `browser.executablePath` (config), which
outranks the Playwright default.

## The project workspace

`gameprob init` creates `<project>/.gameprob/` and never overwrites your files:

```
.gameprob/
├── AGENTS.md      # the contract your coding agent reads
├── config.json    # url, viewport, browser, session, output
├── bridge.ts      # how the game exposes scene/camera/renderer to GameProb
├── progress.md    # what the agent verified, and what it did not
├── tests/         # durable specs, run by `gameprob run`
└── bugs/          # evidence-backed findings
```

`init` is idempotent. Re-running it reports template-version mismatches instead
of silently replacing your edits.

### `config.json`

```json
{
  "schemaVersion": 1,
  "project": { "name": "spinner", "engineHint": "three" },
  "game": { "url": "http://127.0.0.1:5199/?gameprob=1" },
  "browser": {
    "headless": true,
    "backend": "chromium-shell",
    "viewport": { "width": 960, "height": 540 },
    "executablePath": "/usr/bin/chromium"
  },
  "session": { "idleTimeoutMs": 1800000 },
  "output": { "directory": ".gameprob/output" }
}
```

Unknown keys are rejected — a typo fails loudly instead of being ignored.
Precedence is `flags > environment > .gameprob/config.json > ~/.gameprob/config.json > defaults`.

## Commands

| Command | What it does |
|---|---|
| `init [--link-agents]` | Create/refresh `.gameprob/`; `--link-agents` adds one reference to the root `AGENTS.md` |
| `open [url] [--headed] [--allow-remote]` | Start the daemon + Chromium, navigate, report bridge/readiness/capabilities |
| `snapshot [--depth N] [--limit N] [--delta]` | Bounded scene tree with session-local `@gN` refs |
| `inspect <@ref\|selector> [--details]` | Transform, bounds, geometry/material, parent/children, warnings |
| `act keydown\|keyup\|press\|click\|step` | Real browser input, or deterministic simulation stepping |
| `capture [@ref] [--page] [--views …] [--out …] [--overwrite]` | Page or object screenshots, verified non-blank |
| `run [spec] [--workers N]` | Execute `.gameprob/tests/**/*.spec.ts` with Playwright Test |
| `close` | Stop the browser session and this project's daemon |
| `skills get core [--full]` | The guide bundled with the installed version |

Global flags: `--project <dir>`, `--json`, `--debug`. Only loopback targets are
allowed unless you pass `--allow-remote`.

### Selectors

```bash
gameprob inspect gameprob:id=main-hero   # persistent — use this in saved tests
gameprob inspect name:Hero               # only when the name is unique
gameprob inspect type:SkinnedMesh        # first match, with a warning
gameprob inspect @g2                     # session-local; never in a saved test
```

`@gN` refs are invalidated by reload/reset and fail with `STALE_REF`.

## Writing tests

```ts
import { expect, test } from "gameprob/test";

test("the wall stops the hero", async ({ game }) => {
  await game.reset("near-wall");
  await game.action("hold", { key: "ArrowRight" });
  await game.step(240);
  await game.action("release", { key: "ArrowRight" });

  const state = await game.state();
  expect(state.heroX).toBeLessThanOrEqual(state.maxHeroX);
  expect(state.touchesWall).toBe(true);
});
```

The fixture gives you `open`, `snapshot`, `inspect`, `act`, `capture`,
`capabilities`, plus `reset`, `step`, `state` and `action` when the project has
registered simulation hooks. Capability-dependent methods throw a typed
`CAPABILITY_UNAVAILABLE` error rather than pretending to work.

`gameprob run` executes specs in **isolated browser contexts** — never in the
daemon's interactive page — and writes `result.json`, a Playwright JSON report
and a log under `.gameprob/output/run-<timestamp>/`.

## Exit codes

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

## Example

`examples/spinner/` is a tiny Three.js game with a moving hero, a wall and a
controllable simulation. It is the vertical slice the integration tests drive:

```bash
node examples/spinner/server.mjs            # http://127.0.0.1:5199
GAMEPROB_CHROMIUM_PATH=/usr/bin/chromium \
  node dist/cli.js --project examples/spinner open --json
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm test           # unit tests (fast, no browser)
pnpm build          # tsdown -> dist/
pnpm test:integration   # real Chromium against examples/spinner
pnpm test:e2e           # full CLI flow, printed as a step list
pnpm verify:package     # what npm would actually ship
pnpm verify:install     # pack, install into a throwaway project, run the bin
pnpm check              # typecheck + lint + test + build
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`docs/DECISIONS.md`](./docs/DECISIONS.md)
and [`docs/IMPLEMENTATION_STATUS.md`](./docs/IMPLEMENTATION_STATUS.md).

## License

MIT
