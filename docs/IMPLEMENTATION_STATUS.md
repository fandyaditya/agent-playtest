# Implementation Status

## Last verified state

- **Revision**: `4c505a8` on `main`, pushed to
  `git@github.com:fandyaditya/agent-playtest.git`
- **Environment**: Alpine Linux 3.24.2 (musl), Node v24.18.1, pnpm 10.34.6,
  system Chromium 152 with `chromium-swiftshader`, **1 visible CPU** on a shared
  host (load average 18–38 during this work).
- **Last passing checks** (all on the revision above):

| Check | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | **15 files, 169 tests passed** (57 s) |
| Typecheck | `pnpm typecheck` | clean |
| Lint | `pnpm lint` | `Checked 76 files. No fixes applied.` |
| Build | `pnpm build` | 13 files, 171 KiB, `dist/cli.js` 45.7 KiB |
| Integration | `pnpm test:integration` | **2 files, 9 tests passed** (568 s, load 30) |
| End-to-end | `pnpm test:e2e` | **E2E OK** — 9/9 steps |
| Package | `pnpm verify:package` | 25 files, 200 KiB unpacked (tarball 59 KiB) |
| Install smoke | `pnpm verify:install` | 15/15 checks, `install smoke OK` |

## Milestones

- [x] **M0 — Tooling**: TypeScript 5.9 (strict, `allowImportingTsExtensions`,
      `noUncheckedIndexedAccess`), tsdown bundling (CLI, bridge, test fixture,
      daemon, `.d.ts`), Biome, Vitest (unit + integration configs), pnpm
      workspace with the example as a real consumer.
- [x] **M1 — Init + skill**: `init` creates `.gameprob/` (7 files) without
      touching game source, is idempotent, preserves edits, reports
      template-version mismatches instead of applying them; `skills get core
      [--full]` prints version-matched guides from bundled data; engine
      detection from `package.json`/source imports.
- [x] **M2 — Local browser daemon**: per-project daemon on a Unix socket
      (0600 + token), length-prefixed JSON framing, serial queue with bounded
      depth, idle timeout, session meta under `~/.gameprob/`, `close` and stale
      socket recovery, protocol-version mismatch detection.
- [x] **M3 — Three.js snapshot/inspect**: pre-order traversal with depth/limit
      bounds, `@gN` refs with `STALE_REF` detection, delta snapshots, world-space
      bounds, geometry/material/skeleton/animation inspection, honest warnings
      (unverified blankness, bind-pose bounds, per-frame render counters).
- [x] **M4 — Character capture**: object capture through a cloned camera and one
      injected frame (restored in `finally`), `--views front,back,left,right,top,
      bottom,current`, blank-frame detection via in-page `readPixels`, manifest
      written next to the PNGs.
- [x] **M5 — Saved test runner**: `gameprob run [spec]` spawns Playwright Test in
      a child process with an isolated browser context per test, writes
      `result.json` + Playwright JSON report + log, maps failures to
      `TEST_FAILED` (exit 5), and passes positional specs through to execution.
- [ ] **M6 — Simulation/physics** (documented as "later"): the bridge contract,
      capabilities and the `gameprob/test` fixture support
      `reset`/`step`/`state`/`action`/`pause`, and `examples/spinner` implements
      them — verified by the wall-clamp test. A physics-engine integration
      (Rapier/Cannon) is **not** implemented.
- [ ] **M7 — Phaser** (documented as "later"): `templates/project/bridge.phaser.ts`
      is generated and documents the intended shape, but **no Phaser adapter
      ships in V1**. A Phaser project gets browser-only mode plus a clear
      `CAPABILITY_UNAVAILABLE`.

## Verified observations (example game, real Chromium)

```
open      → Browser: Chromium headless shell @ /usr/bin/chromium
            Bridge: connected (three)   Game ready: true
            capabilities: capture.object, capture.page, input.keyboard,
            input.pointer, scene.inspect, scene.snapshot, simulation.action,
            simulation.pause, simulation.reset, simulation.state, simulation.step
snapshot  → scene "spinner-scene", 7 objects, depth 4, truncated false
            @g5 Hero [gameprob:id=main-hero], @g6 Wall, @g7 Obstacle
inspect   → Mesh, world-3d, position [0, 0.4, 0], bounds size [1.126, 0.8, 1.126]
act       → keydown ArrowRight + step 240 (dt = 1/60) → x = 1.52 exactly
            (MAX_HERO_X = WALL_INNER_X - HERO_HALF_WIDTH = 1.92 - 0.4)
capture   → page 960x540 non-blank ~17.9 kB; object front/right 960x540 non-blank
run       → 3/3 example specs passed (fresh contexts, 1.9–9.5 min depending
            on host load)
```

WebGL comes from the distro Chromium with `chromium-swiftshader`; the default
launch needs no extra flags. Measured: `WebGL 2.0 (OpenGL ES 3.0 Chromium) |
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`.

## Bugs found by verification (fixed, with the check that caught them)

1. **`npx gameprob` did nothing.** The CLI's direct-invocation guard compared
   `process.argv[1]` (the `node_modules/.bin` symlink) with `import.meta.url`
   (the realpath). Every packaged install exited 0 with no output. Caught by
   `scripts/verify-install.mjs`, added for exactly this class of defect; fixed by
   comparing real paths.
2. **`--overwrite` never reached the browser layer.** It was read once in the
   driver constructor, so a second capture to the same path always failed with
   "Refusing to overwrite existing file". Caught by running the e2e flow twice;
   now read per call, with a repeat-capture assertion in the integration suite.
3. **`gameprob run <spec>` executed everything.** The spec argument only
   narrowed the summary. Fixed by passing the files to Playwright; the earlier
   behaviour is now unrepresentable.
4. **`--headed` warned on every `open`.** `open()` acted on an absent flag.
   Fixed so only `--headed` (true) touches the browser.
5. **Truncated-by-depth snapshots reported `truncated: false`.** An agent could
   have concluded a partial tree was the whole scene. Now reported.
6. **Absolute capture paths.** `--out` resolved through `resolveInsideDirectory`
   reported an absolute path, so downstream `join(projectRoot, path)` broke.
   Paths are project-relative whenever they land inside the project.
7. **Object screenshots failed under load** with `Element is not attached to the
   DOM`. Replaced the element screenshot with a measured, clipped capture; now a
   CDP capture with a portable fallback (measured ~0.8 s vs ~1.7–2.5 s).
8. **Malformed IPC JSON leaked Node-version wording**; now always wrapped with a
   stable `Malformed IPC payload: ` prefix.

## Known failures/blockers

- **Host load makes browser tests slow, not wrong.** This machine has **1 visible
  CPU** and a host load average of 18–38. The browser suites therefore move
  between ~2 and ~10 minutes for identical work. Confirmed by measurement, not
  assumption:
  - same suite, load ~17–21 → 9/9 passed in 407 s;
  - same suite, load ~23–31 → the 300 s/420 s per-test budgets were exceeded
    (tests failed with `Test timeout`, not with a bad assertion);
  - after raising the budgets to 600 s/1320 s and the generated Playwright test
    timeout to 180 s, **9/9 passed in 568 s at load 30**.
  Mitigations: heavy browser tests live only in the opt-in
  `pnpm test:integration` / `pnpm test:e2e`; `pnpm test` (169 unit tests) is
  deterministic and runs in under a minute; the generated Playwright config uses
  a 180 s test timeout with a comment explaining why.
- **Windows/macOS behaviour is unverified.** No such host was available. The code
  avoids platform assumptions (socket path fallback, `realpathSync`, no
  `pkill`-style process management) and CI covers them, but that CI has not run.
- **CI has not executed.** `.github/workflows/ci.yml` is written but this
  environment has no GitHub Actions runner; nothing in it has been observed.
- **`GAMEPROB_EXAMPLE_PORT` / example server reuse**: when a developer already
  serves `examples/spinner` on 5199, the harness and e2e script reuse it instead
  of failing. Verified by reusing a server started hours earlier by hand.

## Deviations from TECH_DOCS.md

All recorded in [`DECISIONS.md`](./DECISIONS.md). The ones worth repeating:

- package/repo naming (`gameprob` vs `agent-playtest`);
- Vitest for both test suites instead of `playwright test` for integration
  (the in-browser specs are still real Playwright specs, run by `gameprob run`);
- one `examples/spinner` instead of three examples;
- `browser.executablePath` + `GAMEPROB_CHROMIUM_PATH` as the container escape
  hatch;
- socket path fallback to `os.tmpdir()` for long project paths.

## Next actions

1. **Run CI on the pushed repository** (`quality`, `cli-smoke` on three OSes,
   `browser-integration`, and the package/install checks) and fix whatever the
   first real CI run surfaces — especially on Windows.
2. **Decide the simulation-hook contract for M6** before adding a physics
   engine, so `reset`/`step`/`state` do not need a second revision.
3. **Implement the Phaser adapter** behind the same compliance tests the Three.js
   adapter passes, then add a Phaser example game.
4. **Make the generated test timeout configurable** (`tests.timeoutMs`) once the
   config schema grows a `tests` section; today the default is a constant.
5. **Publish** (`npm publish`) once CI and a release note exist — not done, and
   not authorized yet.
