# Decisions

Design decisions made while implementing `TECH_DOCS.md`, including every place
where the implementation deliberately differs from the document. Each entry
states the decision, why, and what it costs.

## 1. Repository vs package name

`TECH_DOCS.md` calls the project *GameProb* while the GitHub repository is
`agent-playtest`.

**Decision**: repository, package, CLI binary, workspace and `gameprob/*`
subpath imports are all **`gameprob`**. The repository keeps its given name.

**Why**: a package named `gameprob` matching its binary and its `.gameprob/`
project directory is one less translation an agent has to make. Renaming the
repo is not ours to do.

## 2. pnpm

**Decision**: pnpm with a committed `pnpm-lock.yaml`, plus a workspace so
`examples/spinner` depends on `gameprob: workspace:*`.

**Why**: the example must import `gameprob/test` exactly as a real consumer
would, which needs a real resolution path — not a `file:` shortcut into `dist/`.

## 3. No `three` runtime dependency

**Decision**: the Three.js adapter is written against **structural interfaces**
(`src/bridge/adapters/three-types.ts`). `three` is a dev/example dependency only.

**Why**: `gameprob/bridge` is bundled into the *consumer's* game. A runtime
dependency on a specific Three.js version would force version negotiation on
every project, and the adapter only needs a handful of shapes (Object3D,
Mesh, Camera, WebGLRenderer, material, skeleton).

**Cost**: type drift is possible; the adapter validates what it reads at
runtime and reports `transform.invalid` / `geometry.missing` warnings instead of
trusting the types.

## 4. Object capture: cloned camera + wrapped `renderer.render`

**Decision**: to capture one object, the bridge clones the inspection camera,
frames the subject using the adapter's `viewPlan`, temporarily wraps
`renderer.render`, renders one frame, reads the pixels, and restores the
original method in a `finally`.

**Why**: the alternative — moving the game's real camera — mutates game state
and breaks the session for every later command. A clone plus one injected frame
leaves the running game untouched.

**Cost**: one extra frame is rendered per capture (visible only as a duplicated
frame on screen), and an adapter must expose `viewPlan` for capture to work.

## 5. Blank frames are failures

**Decision**: every capture samples the framebuffer in-page (`gl.readPixels`)
and reports `nonBlank`. A capture of a black/empty frame returns
`nonBlank: false` and the CLI surfaces it as a warning/failure, never as a
successful screenshot.

**Why**: an agent that receives a black PNG will hallucinate a description of
it. Honest failure is more useful than a plausible artifact.

## 6. Canvas capture uses a clipped page screenshot

**Decision**: `screenshotCanvas` measures the canvas with `boundingBox()` and
takes `page.screenshot({ clip })`. It never calls `locator.screenshot()`.

**Why**: element screenshots wait for the element to be "stable" and repeatedly
failed on a busy shared host with `Element is not attached to the DOM` when the
game resizes or re-creates its canvas. A clipped page screenshot has no
stability loop and no element handle to lose.

**Cost**: the clip is measured once, so a canvas that resizes *between* the
measurement and the shot could produce a slightly wrong crop; the capture then
reports the size it actually wrote, so the discrepancy is visible.

## 7. Read commands never start a daemon

**Decision**: `snapshot`, `inspect`, `act`, `capture` and `close` use
`requireSession: true` (existing session only). Only `open` and `run` may spawn
the daemon.

**Why**: a missing session must fail immediately with `SESSION_NOT_FOUND`
(exit 3). Spawning a daemon just to be told there is no browser leaves a
process behind that the user never asked for.

## 8. Unix socket path fallback

**Decision**: when the per-project socket path would exceed the platform limit
(~104 bytes on Linux), the socket moves to `os.tmpdir()`. The meta file stays in
`~/.gameprob/sessions/`.

**Why**: deep project paths are common in CI and monorepos, and a truncated
socket path is an inscrutable failure.

**Cost**: a documented deviation — the socket is no longer colocated with its
metadata. It stays `0600` and token-gated, so the trust boundary is unchanged.

## 9. Daemon entry resolved from package layout

**Decision**: `daemonEntryPath()` looks for `dist/daemon/entry.js`, then
`src/daemon/entry.ts`, relative to `packageRoot()`.

**Why**: `client.ts` is bundled into `dist/cli.js`, so an `import.meta.url`
relative path would resolve inside the bundle and point at the wrong directory.
Resolving from the package root survives bundling, publishing and `--frozen`
installs.

## 10. `--out` semantics

**Decision**: if `--out` ends in `.png` **and** exactly one view is requested,
it is a file path. Otherwise it is a directory, and each view gets a generated
`<slug>-<view>-<timestamp>.png` name.

**Why**: the two intentions are unambiguous, and guessing wrong would either
overwrite a directory or scatter files.

## 11. Reported capture paths are project-relative

**Decision**: a `path` in capture output is relative to the project root
whenever the file lands inside it; absolute paths are only reported when the
caller passed one.

**Why**: `join(projectRoot, view.path)` must be safe for downstream tooling, and
an absolute path silently makes that join produce the wrong file.

## 12. Templates are versioned, never auto-applied

**Decision**: every template carries `gameprob-template-version: N`. `init`
reports a mismatch and leaves the user's file alone.

**Why**: `.gameprob/AGENTS.md` and `bridge.ts` are meant to be edited by the
project. Silently replacing them would destroy work and, worse, change the
project's contract without telling anyone.

## 13. `run <spec>` narrows execution, not reporting

**Decision**: positional spec arguments are passed to Playwright as file
arguments (`playwright test --config … <files>`).

**Why**: the first implementation only filtered the *summary*, so an explicit
`gameprob run foo.spec.ts` still executed every spec. A command must not run
more than it was asked to run.

## 14. Integration tests drive the built CLI

**Decision**: `tests/integration` spawn `dist/cli.js` as a subprocess instead of
importing `src/` in-process.

**Why**: the daemon handshake, the IPC framing, the socket lifecycle and the
real browser are exactly the parts that break. In-process imports would test a
parallel universe.

**Cost**: the suite needs `pnpm build` first and is slow (~7 min), so it is
opt-in via `pnpm test:integration` and excluded from `pnpm test`.

## 15. Vitest for the integration suite (deviation)

**Decision**: `TECH_DOCS.md` proposes `playwright test` for
`test:integration`. The implementation uses **Vitest** for both suites, with
`fileParallelism: false` and generous per-test timeouts.

**Why**: the integration suite asserts on CLI stdout/exit codes as much as on
the browser, and one runner with one reporter keeps failures readable. The
in-browser specs *are* still real Playwright specs — `gameprob run` executes
them through Playwright Test, which is the path that matters for consumers.

## 16. One example game, not three (deviation)

**Decision**: `TECH_DOCS.md` suggests `examples/three-basic`,
`examples/three-collision` and `examples/phaser-basic`. The implementation ships
a single `examples/spinner` that covers all three concerns: rendering, a
collision rule (the wall clamp) and a deterministic simulation with
`reset`/`step`/`state`.

**Why**: three examples would triplicate the bridge wiring and the vendor
routing while testing the same adapter. The Phaser path is a documented plan,
not a shipped adapter, so a Phaser example would be a lie.

## 17. `browser.executablePath` and `GAMEPROB_CHROMIUM_PATH`

**Decision**: add a config field and an environment variable that point
GameProb at a system Chromium.

**Why**: Playwright's bundled Chromium is built against glibc and cannot run on
musl (Alpine) images — it dies with `__memset_chk: symbol not found`. Without
this escape hatch the tool is unusable in exactly the container environments
agents run in.

**Precedence**: environment > project config > user config > Playwright default.
The environment wins because it is a machine-local fact, not a project fact.

## 18. WebGL in containers: install SwiftShader, do not pass flags

**Decision**: document `apk add chromium-swiftshader` rather than shipping
launch flags.

**Why**: measured on this machine, **no** flag combination produced a WebGL
context before SwiftShader was installed (`--use-gl=angle --use-angle=gl|gl-egl`,
`--use-gl=egl`, `--use-gl=desktop`, `--ozone-platform=headless`,
`--use-angle=vulkan`, `--use-angle=swiftshader`, `--in-process-gpu`,
`--disable-gpu-sandbox`, `--use-cmd-decoder=passthrough`, and headed under Xvfb
all reported `{"webgl": false}`). After installing the package, the **default**
launch works: `WebGL 2.0 (OpenGL ES 3.0 Chromium) | ANGLE (Google, Vulkan 1.3.0
(SwiftShader Device (Subzero)), SwiftShader driver)`. Baking in flags would have
been superstition.

## 19. Test isolation via `GAMEPROB_HOME`

**Decision**: every test that touches machine state sets `GAMEPROB_HOME` to a
temporary directory.

**Why**: the machine runtime holds session metadata and the daemon socket. A
test that writes to the developer's real `~/.gameprob/` can hijack a live
session or leave a daemon behind.

## 20. Global flags are declared on every leaf command

**Decision**: `--project`, `--json` and `--debug` are attached to each leaf
command (via `withGlobals`) rather than only to the root program.

**Why**: `gameprob init --project ../game` is what people type, and Commander
does not accept parent options after the subcommand name. `docs-parity.test.ts`
now enforces this for every documented leaf command.

## 21. Truncation is reported for depth pruning too

**Decision**: `traverse()` sets `truncated = true` when a node at the depth
boundary still has children, even if the object limit was never reached.

**Why**: `snapshot --depth 1` returns a partial tree. Returning `truncated:
false` there would let an agent conclude "the scene has 3 objects" — the exact
class of silent lie this tool exists to prevent.

## 22. Extra modules beyond the documented layout

`shared/config.ts`, `daemon/framing.ts`, `cli/output.ts`, `cli/context.ts` and
`cli/detect-engine.ts` are not in the document's file tree.

**Decision**: keep them as separate modules.

**Why**: each one has a single responsibility the document otherwise leaves
inside a much larger file — config precedence, length-prefixed framing, output
policy/exit codes, project context loading, and engine detection from
`package.json`/source imports. They are unit-tested directly, which is only
possible because they are separate.

## 23. Slug hardening

**Decision**: generated capture slugs strip leading/trailing `.` and `-`.

**Why**: an object named `..` or `.hidden` would otherwise create a directory
traversal or a hidden file. Caught by a unit test, not by an incident.
