# Tasks: Full-game load test

- [ ] 1. Add `onMessage` hook to `Bot` and the `FULL_GAME` config helpers (planned questions, rounds, expected duration) to `scripts/load-test.ts`.
- [ ] 2. Install host and bot handlers in `scenario()` when `FULL_GAME=1`. Run the game wait with a timeout, then remove the handlers.
- [ ] 3. Add game fields to the report and JSON output, and fail the run when the game does not finish.
- [ ] 4. Run `npm run typecheck` and `npm test`.
- [ ] 5. Run `FULL_GAME=1 npm run load-test -- 20` against the local server and check the report.
