// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { assertCleanText, cleanName } from "./profanity.js";
import { pickTeam, pointsFor } from "./scoring.js";
import { take } from "./throttle.js";
import type {
  BattleState,
  BoardState,
  EventConfig,
  MatchGroup,
  Player,
  QuizQuestion,
  RoomState,
  RoundRuntime,
  ScreenMode,
} from "./types.js";

export interface EngineEnv {
  config: EventConfig;
  questions: QuizQuestion[];
}

export type Command =
  | { type: "join"; name: string; deviceId: string }
  | { type: "resume"; playerId: string; deviceId: string }
  | { type: "disconnect"; playerId: string }
  | { type: "heartbeat"; playerId: string }
  | { type: "answer"; playerId: string; questionId: string; choiceId: string; clientMsgId: string }
  | { type: "board.place"; playerId: string; tileType: string; x: number; y: number; clientMsgId: string }
  | { type: "board.move"; playerId: string; nodeId: string; x: number; y: number; clientMsgId: string }
  | { type: "board.connect"; playerId: string; from: string; to: string; clientMsgId: string }
  | { type: "board.delete"; playerId: string; nodeId: string; clientMsgId: string }
  | { type: "board.cursor"; playerId: string; x: number; y: number; clientMsgId?: string }
  | { type: "qa.post"; playerId: string; text: string; clientMsgId: string }
  | { type: "qa.upvote"; playerId: string; questionId: string }
  | { type: "match.set"; playerId: string; interests: string[] }
  | { type: "host.lock"; locked: boolean }
  | { type: "host.mode"; mode: ScreenMode }
  | { type: "host.reset" }
  | { type: "host.start" }
  | { type: "host.pause" }
  | { type: "host.resume" }
  | { type: "host.skip" }
  | { type: "host.skipRound" }
  | { type: "host.stop" }
  | { type: "host.kick"; playerId: string; block: boolean }
  | { type: "host.board.clear" }
  | { type: "host.board.lock"; locked: boolean }
  | { type: "host.board.challenge"; challengeId: string | null }
  | { type: "host.qa.answered"; questionId: string; answered: boolean }
  | { type: "host.qa.hide"; questionId: string; hidden: boolean }
  | { type: "tick" };

export interface AnswerAck {
  questionId: string;
  choiceId: string;
  clientMsgId: string;
  duplicate: boolean;
  correct: boolean;
  points: number;
  totalScore: number;
}

export type DirtyKey = "standings" | "board" | "cursors" | "qa" | "match" | "lobby" | "admin";

export interface ApplyResult {
  ok: boolean;
  error?: { code: string; message: string; clientMsgId?: string };
  joined?: { playerId: string };
  answer?: AnswerAck;
  kicked?: { playerId: string; message: string };
  /** Echoed for idempotent board and Q&A writes so the sender can measure one round trip. */
  clientMsgId?: string;
  phaseChanged: boolean;
  modeChanged?: boolean;
  dirty: DirtyKey[];
  /** Absolute time of the next battle timer. null clears it. undefined leaves it. */
  scheduleAt?: number | null;
}

const MODES: ScreenMode[] = ["lobby", "battle", "board", "qa", "match"];

export function planRounds(env: EngineEnv): RoundRuntime[] {
  const per = env.config.battle.questionsPerRound;
  const rounds: RoundRuntime[] = [];
  let cursor = 0;
  env.config.roundPlan.forEach((spec, i) => {
    const count = spec.count ?? per;
    const slice = env.questions.slice(cursor, cursor + count);
    cursor += count;
    rounds.push({
      title: spec.title?.trim() || `Round ${i + 1}`,
      intro: spec.intro?.trim() || null,
      questionIds: slice.map((q) => q.id),
    });
  });
  return rounds;
}

export function createRoom(code: string, now: number): RoomState {
  return {
    code,
    createdAt: now,
    locked: false,
    screenMode: "lobby",
    players: {},
    blockedDeviceIds: [],
    battle: emptyBattle(),
    board: emptyBoard(),
    qa: [],
    matches: [],
    interests: {},
    seq: 1,
    version: 1,
  };
}

function emptyBattle(): BattleState {
  return {
    phase: "idle",
    pausedFrom: null,
    round: 0,
    questionIndex: 0,
    questionId: null,
    rounds: [],
    startedAt: null,
    endsAt: null,
    pausedRemainingMs: null,
    generation: 1,
  };
}

function emptyBoard(): BoardState {
  return { locked: false, challengeId: null, nodes: [], edges: [], cursors: {} };
}

function freshBuckets() {
  return {
    board: { t: 0, n: 0 },
    qa: { t: 0, n: 0 },
    cursor: { t: 0, n: 0 },
    vote: { t: 0, n: 0 },
  };
}

export function roster(state: RoomState): Player[] {
  return Object.values(state.players).filter((p) => !p.kicked);
}

function bump(state: RoomState, playerIds: string[] = []): void {
  state.version += 1;
  for (const id of playerIds) {
    const p = state.players[id];
    if (p) p.version += 1;
  }
}

function fail(code: string, message: string, clientMsgId?: string): ApplyResult {
  return { ok: false, error: { code, message, clientMsgId }, phaseChanged: false, dirty: [] };
}

function ok(partial: Partial<ApplyResult> = {}): ApplyResult {
  return { ok: true, phaseChanged: false, dirty: [], ...partial };
}

function questionMap(env: EngineEnv): Map<string, QuizQuestion> {
  return new Map(env.questions.map((q) => [q.id, q]));
}

function arm(state: RoomState, now: number, durationMs: number): number {
  state.battle.startedAt = now;
  state.battle.endsAt = now + durationMs;
  state.battle.pausedRemainingMs = null;
  state.battle.pausedFrom = null;
  state.battle.generation += 1;
  return state.battle.endsAt;
}

function beginQuestion(state: RoomState, env: EngineEnv, now: number): number {
  const round = state.battle.rounds[state.battle.round - 1];
  const qid = round.questionIds[state.battle.questionIndex];
  state.battle.phase = "question";
  state.battle.questionId = qid;
  return arm(state, now, env.config.battle.questionSeconds * 1000);
}

function beginRound(state: RoomState, env: EngineEnv, roundNumber: number, now: number): ApplyResult {
  if (roundNumber > state.battle.rounds.length) {
    state.battle.phase = "finished";
    state.battle.questionId = null;
    state.battle.endsAt = null;
    state.battle.pausedFrom = null;
    state.battle.pausedRemainingMs = null;
    state.battle.generation += 1;
    bump(state);
    return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: null });
  }
  state.battle.round = roundNumber;
  state.battle.questionIndex = 0;
  const round = state.battle.rounds[roundNumber - 1];
  if (round.intro) {
    state.battle.phase = "intro";
    state.battle.questionId = null;
    const at = arm(state, now, env.config.battle.introSeconds * 1000);
    bump(state);
    return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
  }
  const at = beginQuestion(state, env, now);
  bump(state);
  return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
}

function beginReveal(state: RoomState, env: EngineEnv, now: number): ApplyResult {
  state.battle.phase = "reveal";
  const at = arm(state, now, env.config.battle.revealSeconds * 1000);
  bump(state);
  return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
}

function afterReveal(state: RoomState, env: EngineEnv, now: number): ApplyResult {
  const round = state.battle.rounds[state.battle.round - 1];
  if (state.battle.questionIndex + 1 < round.questionIds.length) {
    state.battle.questionIndex += 1;
    const at = beginQuestion(state, env, now);
    bump(state);
    return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
  }
  if (state.battle.round >= state.battle.rounds.length) {
    return beginRound(state, env, state.battle.round + 1, now);
  }
  state.battle.phase = "break";
  state.battle.questionId = null;
  if (env.config.battle.autoAdvanceRounds) {
    const at = arm(state, now, env.config.battle.roundBreakSeconds * 1000);
    bump(state);
    return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
  }
  state.battle.endsAt = null;
  state.battle.pausedRemainingMs = null;
  state.battle.generation += 1;
  bump(state);
  return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: null });
}

function clearScores(state: RoomState): void {
  for (const p of Object.values(state.players)) {
    p.score = 0;
    p.answers = {};
    p.version += 1;
  }
}

function ensureBank(state: RoomState, env: EngineEnv): ApplyResult | null {
  const rounds = planRounds(env);
  if (rounds.some((r) => r.questionIds.length === 0) || rounds.length === 0) {
    return fail("bank", "Question bank is shorter than the round plan.");
  }
  state.battle.rounds = rounds;
  return null;
}

function playerOrFail(state: RoomState, playerId: string): Player | ApplyResult {
  const player = state.players[playerId];
  if (!player || player.kicked) return fail("not_in_room", "You are not in this room.");
  return player;
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function sharedInterest(ids: string[], state: RoomState): string | null {
  const lists = ids.map((id) => state.interests[id] ?? []);
  if (lists.some((l) => l.length === 0)) return null;
  const [first, ...rest] = lists;
  for (const interest of first) {
    if (rest.every((l) => l.includes(interest))) return interest;
  }
  return null;
}

function rematch(state: RoomState, env: EngineEnv): void {
  const cfg = env.config.match;
  const people = roster(state).filter((p) => (state.interests[p.id]?.length ?? 0) > 0);
  const claimed = new Set<string>();
  const groups: MatchGroup[] = [];

  for (const existing of state.matches) {
    const members = existing.playerIds.filter((id) => people.some((p) => p.id === id));
    if (members.length < cfg.groupSizeMin) continue;
    const kept = members.slice(0, cfg.groupSizeMax);
    const interest = sharedInterest(kept, state);
    if (!interest) continue;
    kept.forEach((id) => claimed.add(id));
    groups.push({
      id: existing.id,
      playerIds: kept,
      names: kept.map((id) => state.players[id]?.name ?? ""),
      interest,
    });
  }

  let pool = people.filter((p) => !claimed.has(p.id));
  while (pool.length >= cfg.groupSizeMin) {
    let best: { i: number; j: number; interest: string; score: number } | null = null;
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        const a = state.interests[pool[i].id] ?? [];
        const b = state.interests[pool[j].id] ?? [];
        const overlap = a.filter((x) => b.includes(x));
        if (overlap.length === 0) continue;
        if (!best || overlap.length > best.score) {
          best = { i, j, interest: overlap[0], score: overlap.length };
        }
      }
    }
    if (!best) break;
    const a = pool[best.i];
    const b = pool[best.j];
    const ids = [a.id, b.id];
    if (cfg.groupSizeMax >= 3) {
      const rest = pool.filter((p) => p !== a && p !== b);
      const third = rest.find((p) => (state.interests[p.id] ?? []).includes(best.interest));
      if (third) ids.push(third.id);
    }
    state.seq += 1;
    groups.push({
      id: `g${state.seq.toString(36)}`,
      playerIds: ids,
      names: ids.map((id) => state.players[id]?.name ?? ""),
      interest: best.interest,
    });
    const drop = new Set(ids);
    pool = pool.filter((p) => !drop.has(p.id));
  }
  state.matches = groups;
}

function touch(player: Player, now: number): void {
  player.lastSeen = now;
  player.lastAction = now;
  player.connected = true;
}

export function apply(state: RoomState, cmd: Command, now: number, env: EngineEnv): ApplyResult {
  switch (cmd.type) {
    case "join": {
      if (state.blockedDeviceIds.includes(cmd.deviceId)) {
        return fail("blocked", "The host blocked this device for the session.");
      }
      const existing = Object.values(state.players).find((p) => p.deviceId === cmd.deviceId && !p.kicked);
      if (existing) {
        touch(existing, now);
        existing.version += 1;
        bump(state);
        return ok({ joined: { playerId: existing.id }, dirty: ["lobby", "admin"] });
      }
      if (state.locked) return fail("locked", "This room is locked.");
      const cleaned = cleanName(cmd.name);
      if (!cleaned.ok) return fail("bad_name", cleaned.message);
      if (roster(state).length >= env.config.roomCap) return fail("full", "This room is full.");
      const counts = new Map(env.config.teams.map((t) => [t.id, 0]));
      for (const p of roster(state)) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
      let name = cleaned.name;
      const taken = new Set(roster(state).map((p) => p.name.toLowerCase()));
      if (taken.has(name.toLowerCase())) {
        let n = 2;
        while (taken.has(`${cleaned.name} ${n}`.toLowerCase())) n += 1;
        name = `${cleaned.name} ${n}`;
      }
      state.seq += 1;
      const id = `p${state.seq.toString(36)}`;
      const player: Player = {
        id,
        deviceId: cmd.deviceId,
        name,
        teamId: pickTeam(counts, env.config.teams.map((t) => t.id)),
        score: 0,
        connected: true,
        lastSeen: now,
        lastAction: now,
        joinedAt: now,
        kicked: false,
        answers: {},
        buckets: freshBuckets(),
        version: 1,
      };
      state.players[id] = player;
      bump(state);
      return ok({ joined: { playerId: id }, dirty: ["lobby", "admin", "standings"] });
    }
    case "resume": {
      const player = state.players[cmd.playerId];
      if (!player || player.kicked) return fail("not_in_room", "That session is no longer in the room.");
      if (player.deviceId !== cmd.deviceId) return fail("not_in_room", "That session does not match this device.");
      if (state.blockedDeviceIds.includes(cmd.deviceId)) return fail("blocked", "The host blocked this device for the session.");
      touch(player, now);
      player.version += 1;
      bump(state);
      return ok({ joined: { playerId: player.id }, dirty: ["lobby", "admin"] });
    }
    case "disconnect": {
      const player = state.players[cmd.playerId];
      if (!player) return ok();
      player.connected = false;
      player.version += 1;
      delete state.board.cursors[player.id];
      bump(state);
      return ok({ dirty: ["lobby", "admin", "cursors"] });
    }
    case "heartbeat": {
      const player = state.players[cmd.playerId];
      if (!player || player.kicked) return fail("not_in_room", "You are not in this room.");
      player.lastSeen = now;
      player.connected = true;
      return ok({ dirty: ["admin"] });
    }
    case "answer": {
      const found = playerOrFail(state, cmd.playerId);
      if (!("id" in found)) return found;
      const player = found;
      const prior = player.answers[cmd.questionId];
      if (prior) {
        return ok({
          answer: {
            questionId: prior.questionId,
            choiceId: prior.choiceId,
            clientMsgId: cmd.clientMsgId,
            duplicate: true,
            correct: prior.correct,
            points: prior.points,
            totalScore: player.score,
          },
        });
      }
      const battle = state.battle;
      if (battle.phase !== "question" || battle.questionId !== cmd.questionId || battle.endsAt == null) {
        return fail("closed", "That question is closed.", cmd.clientMsgId);
      }
      if (now > battle.endsAt) return fail("closed", "Time is up for that question.", cmd.clientMsgId);
      const quiz = questionMap(env).get(cmd.questionId);
      if (!quiz || !quiz.choices.some((c) => c.id === cmd.choiceId)) {
        return fail("bad_choice", "Pick one of the answers.", cmd.clientMsgId);
      }
      const elapsed = Math.max(0, now - (battle.startedAt ?? now));
      const correct = quiz.correct === cmd.choiceId;
      const points = pointsFor(
        correct,
        elapsed,
        env.config.battle.questionSeconds * 1000,
        env.config.battle.pointsBase,
        env.config.battle.pointsSpeed,
      );
      player.answers[cmd.questionId] = {
        questionId: cmd.questionId,
        choiceId: cmd.choiceId,
        correct,
        points,
        receivedAt: now,
        clientMsgId: cmd.clientMsgId,
        elapsedMs: elapsed,
      };
      player.score += points;
      touch(player, now);
      player.version += 1;
      bump(state);
      return ok({
        answer: {
          questionId: cmd.questionId,
          choiceId: cmd.choiceId,
          clientMsgId: cmd.clientMsgId,
          duplicate: false,
          correct,
          points,
          totalScore: player.score,
        },
        dirty: ["standings", "admin"],
      });
    }
    case "board.place":
    case "board.move":
    case "board.connect":
    case "board.delete": {
      const found = playerOrFail(state, cmd.playerId);
      if (!("id" in found)) return found;
      const player = found;
      if (state.board.locked) return fail("board_locked", "The host locked the board.", cmd.clientMsgId);
      if (!take(player.buckets.board, now, env.config.board.rateLimitPerSec, 1000)) {
        return fail("slow", "Slow down a little.", cmd.clientMsgId);
      }
      if (cmd.type === "board.place") {
        if (!env.config.board.tiles.some((t) => t.id === cmd.tileType)) {
          return fail("bad_tile", "Unknown service tile.", cmd.clientMsgId);
        }
        if (state.board.nodes.length >= env.config.board.maxNodes) {
          return fail("board_full", "The board is full.", cmd.clientMsgId);
        }
        state.seq += 1;
        state.board.nodes.push({
          id: `n${state.seq.toString(36)}`,
          tileType: cmd.tileType,
          x: clamp(cmd.x),
          y: clamp(cmd.y),
          by: player.id,
          byName: player.name,
        });
      } else if (cmd.type === "board.move") {
        const node = state.board.nodes.find((n) => n.id === cmd.nodeId);
        if (!node) return fail("missing", "That tile is gone.", cmd.clientMsgId);
        node.x = clamp(cmd.x);
        node.y = clamp(cmd.y);
      } else if (cmd.type === "board.connect") {
        if (cmd.from === cmd.to) return fail("bad_edge", "Pick two different tiles.", cmd.clientMsgId);
        const has = (id: string) => state.board.nodes.some((n) => n.id === id);
        if (!has(cmd.from) || !has(cmd.to)) return fail("missing", "That tile is gone.", cmd.clientMsgId);
        const dup = state.board.edges.some(
          (e) => (e.from === cmd.from && e.to === cmd.to) || (e.from === cmd.to && e.to === cmd.from),
        );
        if (dup) return fail("bad_edge", "Those tiles are already connected.", cmd.clientMsgId);
        if (state.board.edges.length >= env.config.board.maxEdges) {
          return fail("board_full", "The board is full.", cmd.clientMsgId);
        }
        state.seq += 1;
        state.board.edges.push({ id: `e${state.seq.toString(36)}`, from: cmd.from, to: cmd.to, by: player.id });
      } else {
        state.board.nodes = state.board.nodes.filter((n) => n.id !== cmd.nodeId);
        state.board.edges = state.board.edges.filter((e) => e.from !== cmd.nodeId && e.to !== cmd.nodeId);
      }
      touch(player, now);
      player.version += 1;
      bump(state);
      return ok({ dirty: ["board", "admin"], clientMsgId: cmd.clientMsgId });
    }
    case "board.cursor": {
      const player = state.players[cmd.playerId];
      if (!player || player.kicked) return ok();
      if (!take(player.buckets.cursor, now, 12, 1000)) return ok();
      const team = env.config.teams.find((t) => t.id === player.teamId);
      state.board.cursors[player.id] = {
        playerId: player.id,
        name: player.name,
        color: team?.color ?? "#FF9900",
        x: clamp(cmd.x),
        y: clamp(cmd.y),
        ts: now,
      };
      player.lastSeen = now;
      player.connected = true;
      return ok({ dirty: ["cursors"], clientMsgId: cmd.clientMsgId });
    }
    case "qa.post": {
      const found = playerOrFail(state, cmd.playerId);
      if (!("id" in found)) return found;
      const player = found;
      const cleaned = assertCleanText(cmd.text, env.config.qa.maxQuestionLength);
      if (!cleaned.ok) return fail("bad_text", cleaned.message, cmd.clientMsgId);
      if (!take(player.buckets.qa, now, env.config.qa.rateLimitPerMin, 60_000)) {
        return fail("slow", "Give it a minute before the next question.", cmd.clientMsgId);
      }
      state.seq += 1;
      state.qa.push({
        id: `q${state.seq.toString(36)}`,
        text: cleaned.text,
        by: player.id,
        byName: player.name,
        upvotes: 0,
        voters: [],
        answered: false,
        hidden: false,
        createdAt: now,
      });
      touch(player, now);
      player.version += 1;
      bump(state);
      return ok({ dirty: ["qa", "admin"], clientMsgId: cmd.clientMsgId });
    }
    case "qa.upvote": {
      const found = playerOrFail(state, cmd.playerId);
      if (!("id" in found)) return found;
      const player = found;
      const item = state.qa.find((q) => q.id === cmd.questionId && !q.hidden);
      if (!item) return fail("missing", "That question is gone.");
      if (!take(player.buckets.vote, now, 8, 1000)) return fail("slow", "Slow down a little.");
      if (item.voters.includes(player.id)) {
        item.voters = item.voters.filter((id) => id !== player.id);
        item.upvotes = Math.max(0, item.upvotes - 1);
      } else {
        item.voters.push(player.id);
        item.upvotes += 1;
      }
      touch(player, now);
      bump(state);
      return ok({ dirty: ["qa", "admin"] });
    }
    case "match.set": {
      const found = playerOrFail(state, cmd.playerId);
      if (!("id" in found)) return found;
      const player = found;
      const allowed = new Set(env.config.match.interests);
      const interests = [...new Set(cmd.interests.filter((i) => allowed.has(i)))].slice(0, 8);
      state.interests[player.id] = interests;
      rematch(state, env);
      touch(player, now);
      bump(state);
      return ok({ dirty: ["match", "admin"] });
    }
    case "host.lock": {
      state.locked = cmd.locked;
      bump(state);
      return ok({ dirty: ["admin", "lobby"] });
    }
    case "host.mode": {
      if (!MODES.includes(cmd.mode)) return fail("bad_mode", "Unknown projector view.");
      state.screenMode = cmd.mode;
      bump(state);
      return ok({ dirty: ["admin"], modeChanged: true });
    }
    case "host.reset": {
      clearScores(state);
      for (const p of Object.values(state.players)) p.kicked = false;
      state.blockedDeviceIds = [];
      state.battle = emptyBattle();
      state.board = emptyBoard();
      state.qa = [];
      state.matches = [];
      state.interests = {};
      state.locked = false;
      state.screenMode = "lobby";
      bump(state);
      return ok({ phaseChanged: true, dirty: ["standings", "board", "qa", "match", "lobby", "admin", "cursors"], scheduleAt: null });
    }
    case "host.start": {
      if (state.battle.phase === "finished" || state.battle.phase === "idle") {
        if (state.battle.phase === "finished") clearScores(state);
        const bankError = ensureBank(state, env);
        if (bankError) return bankError;
        let modeChanged = false;
        if (state.screenMode === "lobby") {
          state.screenMode = "battle";
          modeChanged = true;
        }
        const started = beginRound(state, env, 1, now);
        started.modeChanged = modeChanged;
        return started;
      }
      if (state.battle.phase === "break" && state.battle.endsAt == null) {
        return beginRound(state, env, state.battle.round + 1, now);
      }
      return fail("running", "A round is already running.");
    }
    case "host.pause": {
      const phase = state.battle.phase;
      if (phase !== "intro" && phase !== "question" && phase !== "reveal" && phase !== "break") {
        return fail("nothing", "Nothing to pause.");
      }
      if (state.battle.endsAt == null) return fail("nothing", "Nothing to pause.");
      state.battle.pausedFrom = phase;
      state.battle.pausedRemainingMs = Math.max(0, state.battle.endsAt - now);
      state.battle.endsAt = null;
      state.battle.phase = "paused";
      state.battle.generation += 1;
      bump(state);
      return ok({ phaseChanged: true, dirty: ["admin", "standings"], scheduleAt: null });
    }
    case "host.resume": {
      if (state.battle.phase !== "paused" || !state.battle.pausedFrom) return fail("nothing", "Nothing is paused.");
      state.battle.phase = state.battle.pausedFrom;
      const at = arm(state, now, state.battle.pausedRemainingMs ?? 0);
      bump(state);
      return ok({ phaseChanged: true, dirty: ["admin", "standings"], scheduleAt: at });
    }
    case "host.skip": {
      if (state.battle.phase === "paused" && state.battle.pausedFrom) {
        state.battle.phase = state.battle.pausedFrom;
        state.battle.pausedFrom = null;
        state.battle.pausedRemainingMs = null;
      }
      if (state.battle.phase === "intro") return { ...beginQuestionWrapped(state, env, now) };
      if (state.battle.phase === "question") return beginReveal(state, env, now);
      if (state.battle.phase === "reveal") return afterReveal(state, env, now);
      if (state.battle.phase === "break") return beginRound(state, env, state.battle.round + 1, now);
      return fail("nothing", "Nothing to skip.");
    }
    case "host.skipRound": {
      if (state.battle.phase === "idle" || state.battle.round === 0) return fail("nothing", "Start a round first.");
      return beginRound(state, env, state.battle.round + 1, now);
    }
    case "host.stop": {
      if (state.battle.phase === "idle") return fail("nothing", "Nothing is running.");
      state.battle.phase = "finished";
      state.battle.endsAt = null;
      state.battle.pausedFrom = null;
      state.battle.questionId = null;
      state.battle.generation += 1;
      bump(state);
      return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: null });
    }
    case "host.kick": {
      const player = state.players[cmd.playerId];
      if (!player || player.kicked) return fail("missing", "That player is not in the room.");
      player.kicked = true;
      player.connected = false;
      player.version += 1;
      delete state.board.cursors[player.id];
      if (cmd.block && !state.blockedDeviceIds.includes(player.deviceId)) {
        state.blockedDeviceIds.push(player.deviceId);
      }
      delete state.interests[player.id];
      rematch(state, env);
      bump(state);
      return ok({
        kicked: {
          playerId: player.id,
          message: cmd.block
            ? "The host removed you and blocked this device for the session."
            : "The host removed you from the room.",
        },
        dirty: ["lobby", "standings", "admin", "match", "cursors"],
      });
    }
    case "host.board.clear": {
      state.board.nodes = [];
      state.board.edges = [];
      state.board.cursors = {};
      bump(state);
      return ok({ dirty: ["board", "cursors", "admin"] });
    }
    case "host.board.lock": {
      state.board.locked = cmd.locked;
      bump(state);
      return ok({ dirty: ["board", "admin"] });
    }
    case "host.board.challenge": {
      if (cmd.challengeId && !env.config.board.challenges.some((c) => c.id === cmd.challengeId)) {
        return fail("missing", "Unknown challenge.");
      }
      state.board.challengeId = cmd.challengeId;
      bump(state);
      return ok({ dirty: ["board", "admin"] });
    }
    case "host.qa.answered": {
      const item = state.qa.find((q) => q.id === cmd.questionId);
      if (!item) return fail("missing", "That question is gone.");
      item.answered = cmd.answered;
      bump(state);
      return ok({ dirty: ["qa", "admin"] });
    }
    case "host.qa.hide": {
      const item = state.qa.find((q) => q.id === cmd.questionId);
      if (!item) return fail("missing", "That question is gone.");
      item.hidden = cmd.hidden;
      bump(state);
      return ok({ dirty: ["qa", "admin"] });
    }
    case "tick": {
      const phase = state.battle.phase;
      if (phase === "paused" || phase === "idle" || phase === "finished") return ok();
      if (state.battle.endsAt == null || now < state.battle.endsAt) return ok();
      if (phase === "intro") return beginQuestionWrapped(state, env, now);
      if (phase === "question") return beginReveal(state, env, now);
      if (phase === "reveal") return afterReveal(state, env, now);
      if (phase === "break") return beginRound(state, env, state.battle.round + 1, now);
      return ok();
    }
    default:
      return fail("bad_message", "Unknown command.");
  }
}

function beginQuestionWrapped(state: RoomState, env: EngineEnv, now: number): ApplyResult {
  const at = beginQuestion(state, env, now);
  bump(state);
  return ok({ phaseChanged: true, dirty: ["standings", "admin"], scheduleAt: at });
}

export function findQuestion(env: EngineEnv, id: string | null): QuizQuestion | null {
  if (!id) return null;
  return env.questions.find((q) => q.id === id) ?? null;
}
