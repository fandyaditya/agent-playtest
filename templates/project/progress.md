<!-- agent-playtest-template-version: 1 -->
# Agent Playtest QA Progress

Keep this short and factual. Separate what was observed from what is assumed.

## Project facts (verified)

- Engine: not yet observed in a live connected bridge
- Main scene: unknown

## Tests

- [ ] Startup loads successfully
- [ ] Character object discovered
- [ ] Wall collision (requires simulation hooks)

## Open issues

None yet. Bug records live in `.agent-playtest/bugs/` as `GP-0001.md` and use the
observation / evidence / reproduction / hypotheses / verification structure.

## Current blockers

- Bridge not connected yet: run `agent-playtest init`, then connect `.agent-playtest/bridge.ts`.

## Next actions

1. Read `agent-playtest skills get core` for the installed CLI version.
2. Find the real scene/camera/renderer references and connect the bridge.
3. Run `agent-playtest open`, `snapshot`, `inspect @g1` and record what was observed.
