import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateConfig } from "../src/shared/event-config.js";
import { apply, createRoom, planRounds, type EngineEnv } from "../src/shared/engine.js";
import { isProfane } from "../src/shared/profanity.js";
import { loadQuestions, validateQuestions } from "../src/shared/questions.js";
import { pointsFor, pickTeam } from "../src/shared/scoring.js";
import { LoginThrottle } from "../src/shared/throttle.js";
import { hashSecret, issueToken, readToken, verifySecret } from "../src/shared/tokens.js";
import { battleView, playerView, screenView } from "../src/shared/views.js";

const config = loadConfig();
const questions = loadQuestions();
const env: EngineEnv = { config, questions };
const features = { bedrockSummary: false };

test("shipped event defaults match the meetup brief", () => {
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(validateQuestions(questions, config), []);
  assert.equal(config.region, "ap-southeast-2");
  assert.equal(config.roomCap, 300);
  assert.equal(config.expectedAttendees, 50);
  assert.equal(config.teams.length, 8);
  assert.deepEqual(
    config.teams.map((t) => t.name),
    ["Lambda", "S3", "DynamoDB", "CloudFront", "Bedrock", "EC2", "SQS", "Kinesis"],
  );
  assert.equal(config.battle.rounds, 5);
  assert.equal(config.battle.questionsPerRound, 6);
  assert.equal(config.battle.questionSeconds, 20);
  assert.equal(questions.length, 30);
  const story = config.roundPlan[2];
  assert.equal(story.title, "A student app just lost its photos");
  assert.equal(story.intro, "A student app just lost its photos. What do you do next?");
  const rounds = planRounds(env);
  assert.equal(rounds[2].questionIds.length, 6);
  assert.equal(rounds[2].questionIds[0], "q13");
  assert.equal(rounds[2].questionIds[5], "q18");
  for (const q of questions) {
    assert.equal(q.choices.length, 4);
    assert.ok(q.explanation.length > 20);
  }
});

test("scoring pays more for a faster correct answer and nothing for a miss", () => {
  assert.equal(pointsFor(false, 0, 20_000, 500, 500), 0);
  assert.equal(pointsFor(true, 0, 20_000, 500, 500), 1000);
  assert.equal(pointsFor(true, 20_000, 20_000, 500, 500), 500);
  assert.equal(pointsFor(true, 10_000, 20_000, 500, 500), 750);
});

test("teams fill the smallest team first", () => {
  const ids = config.teams.map((t) => t.id);
  const counts = new Map(ids.map((id) => [id, 0]));
  const seen = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < 17; i += 1) {
    const id = pickTeam(counts, ids);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const values = [...seen.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1);
});

test("profanity filter blocks evasions and allows ordinary words", () => {
  assert.equal(isProfane("hello"), false);
  assert.equal(isProfane("classic"), false);
  assert.equal(isProfane("password"), false);
  assert.equal(isProfane("analytics"), false);
  assert.equal(isProfane("assignment"), false);
  assert.equal(isProfane("Scunthorpe"), false);
  assert.equal(isProfane("this is shit"), true);
  assert.equal(isProfane("f.u.c.k"), true);
});

test("tokens reject tampering and expiry", () => {
  const secret = "test-signing-key";
  const token = issueToken({ r: "p", exp: 5_000, room: "ABCDEF", pid: "p1", did: "d1" }, secret);
  assert.equal(readToken(token, secret, 4_000)?.r, "p");
  assert.equal(readToken(token, secret, 5_001), null);
  assert.equal(readToken(token, "other", 4_000), null);
  const [body, mac] = token.split(".");
  assert.equal(readToken(`${body}.${mac.slice(0, -1)}x`, secret, 4_000), null);
  const stored = hashSecret("pin-pin-pin");
  assert.equal(verifySecret("pin-pin-pin", stored), true);
  assert.equal(verifySecret("nope-nope", stored), false);
});

test("login throttle locks after repeated failures", () => {
  const throttle = new LoginThrottle(5, 600_000, 900_000);
  for (let i = 0; i < 4; i += 1) throttle.fail("1.2.3.4", 1_000);
  assert.equal(throttle.allowed("1.2.3.4", 1_000), true);
  throttle.fail("1.2.3.4", 1_000);
  assert.equal(throttle.allowed("1.2.3.4", 1_000), false);
  assert.equal(throttle.allowed("1.2.3.4", 1_000 + 900_000), true);
});

function join(state: ReturnType<typeof createRoom>, name: string, device: string, now: number) {
  const result = apply(state, { type: "join", name, deviceId: device }, now, env);
  assert.equal(result.ok, true, result.error?.message ?? "join failed");
  return result.joined!.playerId;
}

test("battle scores once, ignores a late or duplicate answer, and keeps the team", () => {
  const now = 1_700_000_000_000;
  const state = createRoom("ABCDEF", now);
  assert.equal(state.screenMode, "lobby");
  const a = join(state, "Ada", "dev-a", now);
  const b = join(state, "Ada", "dev-b", now);
  assert.equal(state.players[b].name, "Ada 2");
  assert.notEqual(state.players[a].teamId, "");
  const started = apply(state, { type: "host.start" }, now, env);
  assert.equal(started.ok, true);
  assert.equal(state.screenMode, "battle");
  assert.equal(state.battle.phase, "question");
  assert.equal(state.battle.questionId, "q01");
  const hidden = battleView(state, env);
  assert.equal(hidden.reveal, null);
  assert.equal(hidden.question?.choices.some((c) => "correct" in c), false);

  const first = apply(
    state,
    { type: "answer", playerId: a, questionId: "q01", choiceId: "a", clientMsgId: "m1" },
    now + 1000,
    env,
  );
  assert.equal(first.answer?.correct, true);
  assert.equal(first.answer?.duplicate, false);
  assert.ok((first.answer?.points ?? 0) > 500);
  const score = state.players[a].score;
  const team = state.players[a].teamId;

  const again = apply(
    state,
    { type: "answer", playerId: a, questionId: "q01", choiceId: "b", clientMsgId: "m2" },
    now + 1500,
    env,
  );
  assert.equal(again.answer?.duplicate, true);
  assert.equal(again.answer?.choiceId, "a");
  assert.equal(state.players[a].score, score);

  const paused = apply(state, { type: "host.pause" }, now + 2000, env);
  assert.equal(paused.ok, true);
  assert.equal(state.battle.phase, "paused");
  const duringPause = apply(state, { type: "tick" }, now + 30_000, env);
  assert.equal(duringPause.phaseChanged, false);
  assert.equal(state.battle.phase, "paused");
  const resumed = apply(state, { type: "host.resume" }, now + 31_000, env);
  assert.equal(resumed.ok, true);
  assert.equal(state.battle.phase, "question");

  const late = apply(
    state,
    { type: "answer", playerId: b, questionId: "q01", choiceId: "a", clientMsgId: "late" },
    (state.battle.endsAt ?? 0) + 5,
    env,
  );
  assert.equal(late.ok, false);
  assert.equal(state.players[b].score, 0);

  apply(state, { type: "disconnect", playerId: a }, now + 4000, env);
  assert.equal(state.players[a].connected, false);
  const back = apply(state, { type: "resume", playerId: a, deviceId: "dev-a" }, now + 5000, env);
  assert.equal(back.ok, true);
  assert.equal(state.players[a].score, score);
  assert.equal(state.players[a].teamId, team);
  assert.equal(state.players[a].connected, true);

  const view = playerView(state, env, a, now + 5000, features);
  assert.equal(view.you.score, score);
  assert.equal(view.battle.reveal, null);
});

test("story round opens with the photo incident, then reveals an explanation", () => {
  let now = 1_700_000_000_000;
  const state = createRoom("ABCDEF", now);
  join(state, "Grace", "dev-g", now);
  apply(state, { type: "host.start" }, now, env);
  // Skip the first two rounds (6 questions each) by jumping rounds.
  apply(state, { type: "host.skipRound" }, now, env);
  now += 10;
  apply(state, { type: "host.skipRound" }, now, env);
  assert.equal(state.battle.round, 3);
  assert.equal(state.battle.phase, "intro");
  assert.equal(state.battle.rounds[2].intro, "A student app just lost its photos. What do you do next?");
  const intro = battleView(state, env);
  assert.equal(intro.question, null);
  now = (state.battle.endsAt ?? now) + 1;
  apply(state, { type: "tick" }, now, env);
  assert.equal(state.battle.phase, "question");
  assert.equal(state.battle.questionId, "q13");
  now = (state.battle.endsAt ?? now) + 1;
  apply(state, { type: "tick" }, now, env);
  assert.equal(state.battle.phase, "reveal");
  const reveal = battleView(state, env);
  assert.equal(reveal.reveal?.correctId, "a");
  assert.match(reveal.reveal?.explanation ?? "", /S3/);
  const screen = screenView(state, env, now, features);
  assert.equal(screen.screenMode, "battle");
});

test("kick can block a rejoin, and the board rate limit trips", () => {
  const now = 1_700_000_000_000;
  const state = createRoom("ABCDEF", now);
  const id = join(state, "Eve", "dev-e", now);
  const kicked = apply(state, { type: "host.kick", playerId: id, block: true }, now, env);
  assert.equal(kicked.kicked?.playerId, id);
  const again = apply(state, { type: "join", name: "Eve", deviceId: "dev-e" }, now + 1, env);
  assert.equal(again.ok, false);
  assert.equal(again.error?.code, "blocked");

  const other = join(state, "Rae", "dev-r", now + 2);
  for (let i = 0; i < 10; i += 1) {
    const placed = apply(
      state,
      { type: "board.place", playerId: other, tileType: "lambda", x: i, y: 10, clientMsgId: `b${i}` },
      now + 3,
      env,
    );
    assert.equal(placed.ok, true);
  }
  const limited = apply(
    state,
    { type: "board.place", playerId: other, tileType: "s3", x: 1, y: 1, clientMsgId: "over" },
    now + 3,
    env,
  );
  assert.equal(limited.error?.code, "slow");
});

test("builder match groups are pairs or trios who share an interest", () => {
  const now = 1_700_000_000_000;
  const state = createRoom("ABCDEF", now);
  const ids = ["Aya", "Ben", "Cam", "Dee"].map((name, i) => join(state, name, `d${i}`, now));
  apply(state, { type: "match.set", playerId: ids[0], interests: ["Serverless", "Data"] }, now, env);
  apply(state, { type: "match.set", playerId: ids[1], interests: ["Serverless"] }, now, env);
  apply(state, { type: "match.set", playerId: ids[2], interests: ["Serverless", "Frontend"] }, now, env);
  apply(state, { type: "match.set", playerId: ids[3], interests: ["Cost"] }, now, env);
  assert.ok(state.matches.length >= 1);
  for (const group of state.matches) {
    assert.ok(group.playerIds.length >= 2 && group.playerIds.length <= 3);
    assert.equal(group.interest, "Serverless");
  }
  assert.equal(state.matches.some((g) => g.playerIds.includes(ids[3])), false);
});

test("room cap and lock are enforced, and Q&A sorts by votes", () => {
  const now = 1_700_000_000_000;
  const tiny = structuredClone(env);
  tiny.config = { ...env.config, roomCap: 2 };
  const state = createRoom("ABCDEF", now);
  join(state, "One", "d1", now);
  join(state, "Two", "d2", now);
  const full = apply(state, { type: "join", name: "Three", deviceId: "d3" }, now, tiny);
  assert.equal(full.error?.code, "full");
  apply(state, { type: "host.lock", locked: true }, now, env);
  const locked = apply(state, { type: "join", name: "Four", deviceId: "d4" }, now, env);
  assert.equal(locked.error?.code, "locked");
  const one = Object.values(state.players)[0];
  const two = Object.values(state.players)[1];
  apply(state, { type: "qa.post", playerId: one.id, text: "How does Lambda scale?", clientMsgId: "qa1" }, now, env);
  apply(state, { type: "qa.post", playerId: two.id, text: "What is a shard?", clientMsgId: "qa2" }, now, env);
  const second = state.qa[1];
  apply(state, { type: "qa.upvote", playerId: one.id, questionId: second.id }, now, env);
  assert.equal(state.qa[1].upvotes, 1);
  apply(state, { type: "host.qa.answered", questionId: second.id, answered: true }, now, env);
  assert.equal(state.qa[1].answered, true);
});

test("host can return the projector to the lobby", () => {
  const now = 1_700_000_000_000;
  const state = createRoom("ABCDEF", now);
  join(state, "Nia", "dn", now);
  apply(state, { type: "host.start" }, now, env);
  assert.equal(state.screenMode, "battle");
  const back = apply(state, { type: "host.mode", mode: "lobby" }, now, env);
  assert.equal(back.modeChanged, true);
  assert.equal(state.screenMode, "lobby");
  assert.equal(screenView(state, env, now, features).lobby.joined, 1);
});
