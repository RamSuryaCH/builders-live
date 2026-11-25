# Requirements: Full-game load test

## Context
`scripts/load-test.ts` joins N bots, starts a battle, and has every bot answer only the first question. It does not cover the rest of the game.

## User stories
1. As an operator, I want to run the load test with `FULL_GAME=1` so that every bot answers every question in every round until the game ends.
2. As an operator, I want the same option to work against a local server and against a remote server (`WS_URL` + `HOST_PIN`).
3. As an operator, I want the report to show how many questions were played, how many rounds completed, answer ack p50 and p95, and operation errors.

## Acceptance criteria
- AC1: With `FULL_GAME=1`, after the host starts the battle, each bot answers each question it receives in phase `question`, once per question id.
- AC2: The run ends when the host sees the battle phase `finished`, or when a timeout derived from the event config expires. A timeout counts as a failure.
- AC3: Question timers, round counts, and intro and break durations come from `content/event.json` through `loadConfig()`. The script does not hardcode them.
- AC4: The report prints questions played (distinct question ids seen in phase `question`, compared with the planned total), rounds completed (rounds that reached `break` or `finished`), `finished` yes or no, answer ack p50 and p95, and the error count.
- AC5: Without `FULL_GAME`, behaviour is unchanged.
- AC6: No changes under `infra/`, `deploy/`, or any AWS resource.
- AC7: The run exits 1 when the game does not finish, using the same failure rules as today.
