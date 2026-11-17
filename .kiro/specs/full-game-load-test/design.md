# Design: Full-game load test

## Approach
Extend `scripts/load-test.ts` in place. No server changes.

- `Bot` gets an optional `onMessage` hook, called for every inbound message before the existing waiter or queue logic. The normal flow does not set it.
- When `FULL_GAME=1`, after the bots join and before `host.start`, the script installs two handlers:
  - Host: records `battle` messages. It collects distinct question ids in phase `question`, round numbers in phases `break` or `finished`, and resolves when phase `finished` arrives. The server broadcasts `battle` to every connection, including the host.
  - Each bot: on a `battle` message in phase `question`, answers the question once with a random choice from `question.choices`. It records latency from `answer.ack.clientTs`, updates `bot.score` from `ack.totalScore`, and counts every `error` message as an op error.
- After the game ends or times out, the handlers are removed. This keeps the existing drop, board, and snapshot checks from double-counting errors.
- The single-question answer block runs only when `FULL_GAME` is not set.

## Timing
Expected duration comes from `loadConfig()`:
`sum(question counts) x (questionSeconds + revealSeconds) + intro rounds x introSeconds + (rounds - 1) x roundBreakSeconds`, plus 60 s of margin.
The watchdog is set to that value plus 120 s. The default config gives about 15 minutes for the 5 x 6 plan.

## Assumptions
- `battle.autoAdvanceRounds` is `true` in `content/event.json`, so the server moves between rounds on its own. If it is `false`, the game stalls at `break` and the run fails by timeout.
- The phase that ends a game is `finished` (`BattlePhase` in `src/shared/types.ts`).
- Shortening timers is out of scope. The script has no timer override, and the request limits changes to the script.

## Output
The existing report gains a game block. The JSON result gains `questionsPlayed`, `questionsPlanned`, `roundsCompleted`, `roundsTotal`, and `finished`.
