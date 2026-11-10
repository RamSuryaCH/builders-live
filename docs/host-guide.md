# Host guide

The host console is the admin dashboard. It works on a phone.

## Sign in

1. Open `/host`.
2. Enter the host PIN you set when you deployed. That PIN is the admin secret.
3. You get a short-lived signed session (8 hours).

The PIN is not in the repository. Deploy stores a scrypt hash in SSM Parameter Store as a SecureString on the standard tier. The server compares a hash. It does not use Secrets Manager. After 5 failed tries in 10 minutes, that IP is locked out for 15 minutes.

## Create the room

Choose **Create room**. You get a 6-character room code and a QR code that points at `/join/<CODE>`.

**Open projector** goes to `/screen/<CODE>`. Before the first round the projector stays on **Lobby**: eight teams fill as people join, with name chips, a live joined count, the QR code, and the room code.

## Projector

Switch the wall from `/host`:

- Lobby
- Team Battle
- Build Board
- Live Q&A
- Builder Match

Starting Team Battle from the lobby also switches the wall to Team Battle. You can switch back to Lobby at any time.

## Team Battle

Defaults, all editable in `content/event.json`:

- 8 teams: Lambda, S3, DynamoDB, CloudFront, Bedrock, EC2, SQS, Kinesis
- Balanced auto-assignment
- 5 rounds of 6 questions, 20 seconds each
- Round 3 is a short story: "A student app just lost its photos. What do you do next?"

Controls: **Start**, **Pause**, **Resume**, **Skip question**, **Skip round**, **Stop**, **Reset**.

Correct answers score 500 points plus up to 500 more for speed. A wrong answer scores 0. A duplicate answer is ignored. The server keeps the score, so a dropped phone does not lose points or its team.

The dashboard shows who is active, idle, or disconnected, progress through the current question, and accuracy per player, per team, and per question.

## People

**Kick** removes someone. Tick **Block rejoining** to refuse that device for the rest of the session. **Lock room** stops new people. People already inside can still reconnect. **Reset** clears scores, the board, questions, and blocks, and returns the wall to the lobby. People stay in their teams.

## Build Board

Pick a challenge, such as "Build a photo-sharing app", then **Set challenge**. **Lock board** freezes edits. **Clear board** removes tiles and lines. Each person is limited to 10 board actions a second. Updates are coalesced to about 8 a second.

## Live Q&A

**Mark answered** and **Hide** update the list for everyone. Upvotes reorder the list live.

**Summarise top questions** is not shown. It only appears if you deploy with `EnableBedrockSummary=true`, which this project leaves off. That path is one host-only Lambda, Amazon Bedrock Converse, a configurable model id (default Amazon Nova Lite), a max token cap, reserved concurrency 1, and an optional Guardrails id. It does not use Knowledge Bases.

## Builder Match

People tick interests on their phones. The server groups them into twos or threes who share an interest. The wall can show the groups when you switch to Builder Match.
