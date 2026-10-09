# Contributing

Thanks for helping make browser games testable by agents. This document is the
short version of how the repository is built; `TECH_DOCS.md` is the design
source of truth, and `docs/DECISIONS.md` records where the implementation
deliberately deviates from it.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm build
```

Verified with **Node 24** and **pnpm 10**. `engines.node` is `>=24` because the
code uses native ESM, `import ... with { type: "json" }`-free JSON reads, and
modern `node:*` APIs without shims.

### A browser for the integration tests

`pnpm test` needs no browser. `pnpm test:integration` and `pnpm test:e2e` do.

```bash
npx playwright install chromium          # normal machines
```

On musl/Alpine, Playwright's glibc bundles cannot run; install the distro
browser instead:

```bash
apk add chromium chromium-swiftshader    # swiftshader provides WebGL
export AGENT_PLAYTEST_CHROMIUM_PATH=/usr/bin/chromium
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over `src`, `tests`, config files |
| `pnpm lint` | `biome check .` |
| `pnpm format` | `biome format --write .` |
| `pnpm test` | Vitest unit tests — fast, deterministic, no browser |
| `pnpm build` | tsdown bundle to `dist/` (CLI, bridge, test fixture, daemon, types) |
| `pnpm test:integration` | Real Chromium + real daemon against `examples/spinner` |
| `pnpm test:e2e` | The same flow as a printable step list |
| `pnpm verify:package` | Tarball contents, exports, shebang, templates |
| `pnpm verify:install` | Pack, install into a throwaway project, run the `bin` symlink |
| `pnpm check` | typecheck + lint + test + build |

Before a PR: `pnpm check && pnpm test:integration && pnpm verify:package && pnpm verify:install`.

## Architecture rules

Keep the dependency directions one-way (see `TECH_DOCS.md` §11):

- `src/shared/` — types, Zod schemas, errors, paths, config. No browser, no CLI.
- `src/bridge/` — in-page code. Must never import `node:*`; it is bundled for
  the browser and imported by the game.
- `src/browser/` — Playwright driver + the abstract bridge protocol.
- `src/daemon/` — the per-project process, IPC framing, session lifecycle.
- `src/cli/` — argument parsing, output policy, exit codes. Never imports Three.js.
- `src/test/` — the Playwright fixture consumers import as `agent-playtest/test`.

The Three.js adapter talks to **structural interfaces** (`three-types.ts`), so
`three` is a dev/example dependency, never a runtime one.

## Adding a CLI command

A command is not done until it has:

1. help text with a real description and argument docs,
2. a Zod-validated daemon contract (or an honest `INVALID_ARGUMENT`),
3. a JSON envelope case and a human renderer in `src/cli/output.ts`,
4. an entry in `skill-data/core.md` and the README table,
5. unit tests for the argument/exit-code surface, and
6. an integration assertion if it touches the browser.

`tests/unit/docs-parity.test.ts` fails when the documented flags and error codes
drift from `buildProgram()` and `EXIT_CODES`, so update the guide in the same
commit.

## Adding an engine adapter

Implement `EngineAdapter<T>` from `src/bridge/adapter.ts`, register it in
`src/bridge/registry.ts`, and prove it against a small example game: traversal,
refs, selector resolution, bounds, inspection and view planning. Reuse
`tests/unit/support/fakes.ts` rather than writing a second inspector.

## Testing expectations

- **Unit** (`tests/unit`) — every pure decision: framing, queueing, refs,
  serialization bounds, config precedence, path safety, adapters, docs parity.
- **Integration** (`tests/integration`) — the real thing: built CLI, daemon,
  Chromium, the bundled example game.
- **Package** (`scripts/verify-package.mjs`) — what `npm publish` would ship.
- **Install** (`scripts/verify-install.mjs`) — the tarball installed into a
  throwaway project and driven through `node_modules/.bin/agent-playtest`. This is the
  only check that exercises the real consumer entry point (a symlink), so a
  packaging or shebang/realpath regression cannot hide in the repository.

Rules of thumb:

- Never assert "it works" without an observable fact (a position, a byte count,
  an exit code, a `nonBlank` flag).
- A regression fix starts with a failing test or a documented reproduction.
- Keep browser-heavy tests out of `pnpm test`; they belong in the opt-in suites.
- Do not compare screenshots across unrelated GPU/browser builds.
- Do not mark an unsupported check as passed.

## Pull requests

- One engine feature, CLI improvement or bug fix per PR.
- No new runtime dependency without saying why the standard library is not enough.
- Strict TypeScript, typed errors, Zod at every boundary, Biome formatting.
- Update `docs/IMPLEMENTATION_STATUS.md` with the commands you actually ran and
  their real output when a milestone moves.
- Avoid platform-specific assumptions (paths, signals, screenshots) without a
  fallback or a documented exclusion.

## Good first issues

- A second example game (2D canvas without an engine) to prove browser-only mode.
- A Phaser adapter for `templates/project/bridge.phaser.ts` (currently a
  documented plan, not a shipped adapter).
- Windows path/socket handling review in `src/shared/paths.ts`.
- A `--delta` snapshot renderer in the human output path.

## License

MIT. By contributing you agree your work is released under the same license.
