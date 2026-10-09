<!-- gameprob-template-version: 1 -->
# GameProb QA Progress

Keep this short and factual. Separate what was observed from what is assumed.

## Project facts (verified)

- Engine: not yet observed in a live connected bridge
- Main scene: unknown

## Tests

- [ ] Startup loads successfully
- [ ] Character object discovered
- [ ] Wall collision (requires simulation hooks)

## Open issues

None yet. Bug records live in `.gameprob/bugs/` as `GP-0001.md` and use the
observation / evidence / reproduction / hypotheses / verification structure.

## Current blockers

- Bridge not connected yet: run `gameprob init`, then connect `.gameprob/bridge.ts`.

## Next actions

1. Read `gameprob skills get core` for the installed CLI version.
2. Find the real scene/camera/renderer references and connect the bridge.
3. Run `gameprob open`, `snapshot`, `inspect @g1` and record what was observed.
