<!-- gameprob-template-version: 1 -->
# GameProb — project instructions

This directory (`.gameprob/`) belongs to **this game project**, not to GameProb
itself. GameProb ships the tooling; the coding agent maintains the integration,
tests, bug records and progress notes here.

## 1. Read the version-matched guide first

```bash
gameprob skills get core          # full workflow for the installed version
gameprob skills get core --full   # adds the reference and troubleshooting sections
```

The guide describes the CLI surface of the *installed* version. Trust it over
any notes in this file.

## 2. Inspect the game architecture before editing integration code

Find the real initialization path: where the scene, camera, renderer (Three.js)
or the Phaser `Game` instance are created, and how assets/scenes are loaded. Do
not guess; read the source.

## 3. Connect the bridge (development only)

Edit `.gameprob/bridge.ts` so it imports the *actual* game references, then add
one small development-only call in the game's initialization code:

```ts
if (import.meta.env.DEV && new URLSearchParams(location.search).get("gameprob") === "1") {
  const { connectGame } = await import("../.gameprob/bridge");
  connectGame({ scene, camera, renderer });
}
```

Adapt the relative path, async location, bundler and scope to the real project.
`?gameprob=1` is **not** a security boundary — the bundler's dev-only condition
is what keeps the bridge out of production. Verify the production build does not
contain it.

## 4. Use live evidence before writing or updating a bug report

```bash
gameprob open http://127.0.0.1:5173/?gameprob=1
gameprob snapshot
gameprob inspect @g1 --details
gameprob capture @g1 --views front,back,left,right
```

`@gN` refs are session-local. Anything durable must use a persistent selector
such as `gameprob:id=main-hero`.

## 5. Keep reusable tests in `.gameprob/tests/`

Tests import `{ test, expect }` from `gameprob/test` and run with:

```bash
gameprob run
```

They must not need an LLM. Do not assert on unsupported capabilities: a check
that cannot run is `unsupported`, never `passed`.

## 6. Record only confirmed observations

Separate, in every bug record:

- raw observation (`hero.worldPosition.x = 1.83`)
- the rule you expected (`x <= 1.52`), which comes from the project test
- the assertion outcome
- hypotheses (labelled as hypotheses)
- verified fixes (with a run ID)

Bounding-box overlap is **not** proof of a physics collision, and a screenshot
difference is **not** automatically an art-direction bug.

## 7. Keep `.gameprob/progress.md` compact

Tested systems, coverage gaps, current blockers, next actions. Update it as work
happens, not at the end.

## 8. Never bend the game to make a test pass

Do not weaken assertions, hide real defects, or change game logic solely to make
a check green.

## 9. Respect the project's editing rules

Changes outside `.gameprob/` follow the user's own permissions and project
instructions.

## 10. No telemetry

GameProb never uploads anything. Do not paste secrets, credentials, cookies or
player data into bug reports or evidence files.
