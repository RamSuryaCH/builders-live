// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
/**
 * Item-level room store used by both DynamoDB and the local memory backend.
 *
 * META (versioned) holds host-controlled state only.
 * Players, answers, board nodes/edges, Q&A and counters are separate items so
 * concurrent joins and answers do not contend on one room version.
 */
import { apply, createRoom, type ApplyResult, type Command, type EngineEnv } from "../shared/engine.js";
import { assertCleanText, cleanName } from "../shared/profanity.js";
import { pointsFor, pickTeam } from "../shared/scoring.js";
import { take } from "../shared/throttle.js";
import type {
  AnswerRecord,
  BoardEdge,
  BoardNode,
  Cursor,
  EventConfig,
  MatchGroup,
  Player,
  QaItem,
  RoomState,
} from "../shared/types.js";

export interface ConnRow {
  id: string;
  role?: string;
  playerId?: string;
  deviceId?: string;
  views?: string[];
}

export interface StoreBackend {
  get(pk: string, sk: string): Promise<Record<string, unknown> | null>;
  put(item: Record<string, unknown>, condition?: string, values?: Record<string, unknown>): Promise<"ok" | "conflict">;
  update(
    pk: string,
    sk: string,
    update: string,
    values: Record<string, unknown>,
    names?: Record<string, string>,
    condition?: string,
  ): Promise<"ok" | "conflict" | "missing">;
  query(pk: string, skPrefix: string): Promise<Record<string, unknown>[]>;
  remove(pk: string, sk: string): Promise<void>;
  ttl(hours?: number): number;
}

function roomPk(code: string): string {
  return `ROOM#${code}`;
}

function freshBuckets() {
  return {
    board: { t: 0, n: 0 },
    qa: { t: 0, n: 0 },
    cursor: { t: 0, n: 0 },
    vote: { t: 0, n: 0 },
  };
}

function emptyBattle() {
  return {
    phase: "idle" as const,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(attempt: number): number {
  const base = Math.min(400, 20 * 2 ** attempt);
  return Math.floor(base * (0.5 + Math.random()));
}

function metaFromState(state: RoomState): Record<string, unknown> {
  return {
    code: state.code,
    createdAt: state.createdAt,
    locked: state.locked,
    screenMode: state.screenMode,
    blockedDeviceIds: state.blockedDeviceIds,
    battle: state.battle,
    boardLocked: state.board.locked,
    challengeId: state.board.challengeId,
    matches: state.matches,
    version: state.version,
    seq: state.seq,
  };
}

function playerItem(code: string, player: Player, ttl: number): Record<string, unknown> {
  const { answers: _a, ...rest } = player;
  return { pk: roomPk(code), sk: `PLAYER#${player.id}`, player: rest, ttl };
}

export class RoomStore {
  constructor(private backend: StoreBackend) {}

  async createRoom(state: RoomState, config?: EventConfig): Promise<void> {
    const ttl = this.backend.ttl();
    const status = await this.backend.put(
      { pk: roomPk(state.code), sk: "META", ...metaFromState(state), ttl },
      "attribute_not_exists(pk)",
    );
    if (status === "conflict") throw new Error("room exists");
    const teams: Record<string, number> = {};
    for (const team of config?.teams ?? []) teams[team.id] = 0;
    await this.backend.put({
      pk: roomPk(state.code),
      sk: "COUNTERS",
      seq: 0,
      joined: 0,
      nodes: 0,
      edges: 0,
      teams,
      ttl,
    });
  }

  async ensureCounters(code: string, config: EventConfig): Promise<void> {
    const existing = await this.backend.get(roomPk(code), "COUNTERS");
    if (existing) return;
    const teams: Record<string, number> = {};
    for (const team of config.teams) teams[team.id] = 0;
    await this.backend.put({
      pk: roomPk(code),
      sk: "COUNTERS",
      seq: 0,
      joined: 0,
      nodes: 0,
      edges: 0,
      teams,
      ttl: this.backend.ttl(),
    });
  }

  async loadRoom(code: string): Promise<RoomState | null> {
    const meta = await this.backend.get(roomPk(code), "META");
    if (!meta) return null;
    const items = await this.backend.query(roomPk(code), "");
    const players: Record<string, Player> = {};
    const answers: Record<string, AnswerRecord & { playerId: string }> = {};
    const nodes: BoardNode[] = [];
    const edges: BoardEdge[] = [];
    const cursors: Record<string, Cursor> = {};
    const qa: QaItem[] = [];
    const interests: Record<string, string[]> = {};
    let counters = { seq: Number(meta.seq ?? 0), joined: 0, nodes: 0, edges: 0, teams: {} as Record<string, number> };

    for (const item of items) {
      const sk = String(item.sk);
      if (sk === "COUNTERS") {
        counters = {
          seq: Number(item.seq ?? 0),
          joined: Number(item.joined ?? 0),
          nodes: Number(item.nodes ?? 0),
          edges: Number(item.edges ?? 0),
          teams: (item.teams as Record<string, number>) ?? {},
        };
      } else if (sk.startsWith("PLAYER#")) {
        const player = item.player as Player;
        if (player?.id) {
          players[player.id] = { ...player, answers: {}, buckets: player.buckets ?? freshBuckets() };
        }
      } else if (sk.startsWith("ANSWER#")) {
        const answer = item.answer as AnswerRecord;
        const playerId = String(item.playerId ?? "");
        if (answer?.questionId && playerId) answers[`${playerId}:${answer.questionId}`] = { ...answer, playerId };
      } else if (sk.startsWith("NODE#")) {
        nodes.push(item.node as BoardNode);
      } else if (sk.startsWith("EDGE#")) {
        edges.push(item.edge as BoardEdge);
      } else if (sk.startsWith("CURSOR#")) {
        const cursor = item.cursor as Cursor;
        if (cursor?.playerId) cursors[cursor.playerId] = cursor;
      } else if (sk.startsWith("QA#")) {
        qa.push(item.qa as QaItem);
      } else if (sk.startsWith("INTEREST#")) {
        interests[sk.slice("INTEREST#".length)] = (item.interests as string[]) ?? [];
      }
    }

    for (const answer of Object.values(answers)) {
      const player = players[answer.playerId];
      if (player) player.answers[answer.questionId] = answer;
    }

    return {
      code: String(meta.code),
      createdAt: Number(meta.createdAt),
      locked: Boolean(meta.locked),
      screenMode: meta.screenMode as RoomState["screenMode"],
      players,
      blockedDeviceIds: (meta.blockedDeviceIds as string[]) ?? [],
      battle: meta.battle as RoomState["battle"],
      board: {
        locked: Boolean(meta.boardLocked),
        challengeId: (meta.challengeId as string | null) ?? null,
        nodes,
        edges,
        cursors,
      },
      qa,
      matches: (meta.matches as MatchGroup[]) ?? [],
      interests,
      seq: counters.seq,
      version: Number(meta.version ?? 1),
    };
  }

  async applyCommand(code: string, cmd: Command, now: number, env: EngineEnv): Promise<ApplyResult> {
    switch (cmd.type) {
      case "join":
        return this.join(code, cmd.name, cmd.deviceId, now, env);
      case "resume":
        return this.resume(code, cmd.playerId, cmd.deviceId, now);
      case "disconnect":
        return this.touchPlayer(code, cmd.playerId, now, false);
      case "heartbeat":
        return this.touchPlayer(code, cmd.playerId, now, true);
      case "answer":
        return this.answer(code, cmd.playerId, cmd.questionId, cmd.choiceId, cmd.clientMsgId, now, env);
      case "board.place":
      case "board.move":
      case "board.connect":
      case "board.delete":
      case "board.cursor":
        return this.board(code, cmd, now, env);
      case "qa.post":
      case "qa.upvote":
        return this.qa(code, cmd, now, env);
      case "match.set":
        return this.matchSet(code, cmd.playerId, cmd.interests, now, env);
      default:
        return this.hostMutate(code, cmd, now, env);
    }
  }

  private async join(code: string, name: string, deviceId: string, now: number, env: EngineEnv): Promise<ApplyResult> {
    await this.ensureCounters(code, env.config);
    const meta = await this.backend.get(roomPk(code), "META");
    if (!meta) return { ok: false, error: { code: "room_not_found", message: "No room with that code." }, phaseChanged: false, dirty: [] };
    const blocked = (meta.blockedDeviceIds as string[]) ?? [];
    if (blocked.includes(deviceId)) {
      return { ok: false, error: { code: "blocked", message: "The host blocked this device for the session." }, phaseChanged: false, dirty: [] };
    }

    const existingDevice = await this.backend.get(roomPk(code), `DEVICE#${deviceId}`);
    if (existingDevice?.playerId) {
      return this.resume(code, String(existingDevice.playerId), deviceId, now);
    }
    if (meta.locked) {
      return { ok: false, error: { code: "locked", message: "This room is locked." }, phaseChanged: false, dirty: [] };
    }
    const cleaned = cleanName(name);
    if (!cleaned.ok) return { ok: false, error: { code: "bad_name", message: cleaned.message }, phaseChanged: false, dirty: [] };

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const counters = await this.backend.get(roomPk(code), "COUNTERS");
      if (!counters) {
        await this.ensureCounters(code, env.config);
        continue;
      }
      const joined = Number(counters.joined ?? 0);
      if (joined >= env.config.roomCap) {
        return { ok: false, error: { code: "full", message: "This room is full." }, phaseChanged: false, dirty: [] };
      }
      const teams = { ...((counters.teams as Record<string, number>) ?? {}) };
      for (const team of env.config.teams) if (teams[team.id] == null) teams[team.id] = 0;
      const teamId = pickTeam(new Map(Object.entries(teams).map(([k, v]) => [k, Number(v)])), env.config.teams.map((t) => t.id));
      const nextSeq = Number(counters.seq ?? 0) + 1;
      const playerId = `p${nextSeq.toString(36)}`;

      let display = cleaned.name;
      for (let n = 0; n < 20; n += 1) {
        const candidate = n === 0 ? cleaned.name : `${cleaned.name} ${n + 1}`;
        const namePut = await this.backend.put(
          { pk: roomPk(code), sk: `NAME#${candidate.toLowerCase()}`, playerId, ttl: this.backend.ttl() },
          "attribute_not_exists(pk)",
        );
        if (namePut === "ok") {
          display = candidate;
          break;
        }
        if (n === 19) return { ok: false, error: { code: "bad_name", message: "Pick a different display name." }, phaseChanged: false, dirty: [] };
      }

      const nextTeams = { ...teams, [teamId]: Number(teams[teamId] ?? 0) + 1 };
      const counted = await this.backend.put(
        {
          pk: roomPk(code),
          sk: "COUNTERS",
          seq: nextSeq,
          joined: joined + 1,
          nodes: Number(counters.nodes ?? 0),
          edges: Number(counters.edges ?? 0),
          teams: nextTeams,
          ttl: this.backend.ttl(),
        },
        "seq = :seq AND joined = :joined",
        { ":seq": Number(counters.seq ?? 0), ":joined": joined },
      );
      if (counted === "conflict") {
        await this.backend.remove(roomPk(code), `NAME#${display.toLowerCase()}`);
        await sleep(jitter(attempt));
        continue;
      }

      const player: Player = {
        id: playerId,
        deviceId,
        name: display,
        teamId,
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
      await this.backend.put(playerItem(code, player, this.backend.ttl()));
      await this.backend.put({ pk: roomPk(code), sk: `DEVICE#${deviceId}`, playerId, ttl: this.backend.ttl() });
      await this.backend.put({
        pk: roomPk(code),
        sk: `TEAM#${teamId}`,
        members: nextTeams[teamId],
        score: 0,
        ttl: this.backend.ttl(),
      });
      return { ok: true, joined: { playerId }, phaseChanged: false, dirty: ["lobby", "admin", "standings"] };
    }
    return { ok: false, error: { code: "busy", message: "The room is busy. Try again." }, phaseChanged: false, dirty: [] };
  }

  private async resume(code: string, playerId: string, deviceId: string, now: number): Promise<ApplyResult> {
    const meta = await this.backend.get(roomPk(code), "META");
    if (!meta) return { ok: false, error: { code: "room_not_found", message: "That room has ended." }, phaseChanged: false, dirty: [] };
    if (((meta.blockedDeviceIds as string[]) ?? []).includes(deviceId)) {
      return { ok: false, error: { code: "blocked", message: "The host blocked this device for the session." }, phaseChanged: false, dirty: [] };
    }
    const item = await this.backend.get(roomPk(code), `PLAYER#${playerId}`);
    const player = item?.player as Player | undefined;
    if (!player || player.kicked) {
      return { ok: false, error: { code: "not_in_room", message: "That session is no longer in the room." }, phaseChanged: false, dirty: [] };
    }
    if (player.deviceId !== deviceId) {
      return { ok: false, error: { code: "not_in_room", message: "That session does not match this device." }, phaseChanged: false, dirty: [] };
    }
    player.connected = true;
    player.lastSeen = now;
    player.lastAction = now;
    player.version += 1;
    await this.backend.put(playerItem(code, player, this.backend.ttl()));
    return { ok: true, joined: { playerId }, phaseChanged: false, dirty: ["lobby", "admin"] };
  }

  private async touchPlayer(code: string, playerId: string, now: number, connected: boolean): Promise<ApplyResult> {
    const item = await this.backend.get(roomPk(code), `PLAYER#${playerId}`);
    const player = item?.player as Player | undefined;
    if (!player) return { ok: true, phaseChanged: false, dirty: [] };
    if (player.kicked && connected) {
      return { ok: false, error: { code: "not_in_room", message: "You are not in this room." }, phaseChanged: false, dirty: [] };
    }
    player.connected = connected;
    player.lastSeen = now;
    if (connected) player.lastAction = now;
    player.version += 1;
    await this.backend.put(playerItem(code, player, this.backend.ttl()));
    if (!connected) await this.backend.remove(roomPk(code), `CURSOR#${playerId}`);
    return { ok: true, phaseChanged: false, dirty: connected ? ["admin"] : ["lobby", "admin", "cursors"] };
  }

  private async answer(
    code: string,
    playerId: string,
    questionId: string,
    choiceId: string,
    clientMsgId: string,
    now: number,
    env: EngineEnv,
  ): Promise<ApplyResult> {
    const playerItemRow = await this.backend.get(roomPk(code), `PLAYER#${playerId}`);
    const player = playerItemRow?.player as Player | undefined;
    if (!player || player.kicked) {
      return { ok: false, error: { code: "not_in_room", message: "You are not in this room.", clientMsgId }, phaseChanged: false, dirty: [] };
    }
    const existing = await this.backend.get(roomPk(code), `ANSWER#${playerId}#${questionId}`);
    if (existing?.answer) {
      const prior = existing.answer as AnswerRecord;
      return {
        ok: true,
        answer: {
          questionId: prior.questionId,
          choiceId: prior.choiceId,
          clientMsgId,
          duplicate: true,
          correct: prior.correct,
          points: prior.points,
          totalScore: player.score,
        },
        phaseChanged: false,
        dirty: [],
      };
    }

    const meta = await this.backend.get(roomPk(code), "META");
    const battle = meta?.battle as RoomState["battle"] | undefined;
    if (!battle || battle.phase !== "question" || battle.questionId !== questionId || battle.endsAt == null || now > battle.endsAt) {
      return { ok: false, error: { code: "closed", message: "That question is closed.", clientMsgId }, phaseChanged: false, dirty: [] };
    }
    const quiz = env.questions.find((q) => q.id === questionId);
    if (!quiz || !quiz.choices.some((c) => c.id === choiceId)) {
      return { ok: false, error: { code: "bad_choice", message: "Pick one of the answers.", clientMsgId }, phaseChanged: false, dirty: [] };
    }
    const elapsed = Math.max(0, now - (battle.startedAt ?? now));
    const correct = quiz.correct === choiceId;
    const points = pointsFor(correct, elapsed, env.config.battle.questionSeconds * 1000, env.config.battle.pointsBase, env.config.battle.pointsSpeed);
    const record: AnswerRecord = {
      questionId,
      choiceId,
      correct,
      points,
      receivedAt: now,
      clientMsgId,
      elapsedMs: elapsed,
    };
    const put = await this.backend.put(
      {
        pk: roomPk(code),
        sk: `ANSWER#${playerId}#${questionId}`,
        playerId,
        answer: record,
        ttl: this.backend.ttl(),
      },
      "attribute_not_exists(pk)",
    );
    if (put === "conflict") {
      const again = await this.backend.get(roomPk(code), `ANSWER#${playerId}#${questionId}`);
      const prior = again?.answer as AnswerRecord;
      return {
        ok: true,
        answer: {
          questionId: prior.questionId,
          choiceId: prior.choiceId,
          clientMsgId,
          duplicate: true,
          correct: prior.correct,
          points: prior.points,
          totalScore: player.score,
        },
        phaseChanged: false,
        dirty: [],
      };
    }
    player.score += points;
    player.lastSeen = now;
    player.lastAction = now;
    player.connected = true;
    player.version += 1;
    await this.backend.put(playerItem(code, player, this.backend.ttl()));
    if (points > 0) {
      await this.backend.update(
        roomPk(code),
        `TEAM#${player.teamId}`,
        "ADD score :p SET #ttl = :ttl",
        { ":p": points, ":ttl": this.backend.ttl() },
        { "#ttl": "ttl" },
      );
    }
    return {
      ok: true,
      answer: {
        questionId,
        choiceId,
        clientMsgId,
        duplicate: false,
        correct,
        points,
        totalScore: player.score,
      },
      phaseChanged: false,
      dirty: ["standings", "admin"],
    };
  }

  private async board(code: string, cmd: Command, now: number, env: EngineEnv): Promise<ApplyResult> {
    if (
      cmd.type !== "board.place" &&
      cmd.type !== "board.move" &&
      cmd.type !== "board.connect" &&
      cmd.type !== "board.delete" &&
      cmd.type !== "board.cursor"
    ) {
      return { ok: false, error: { code: "bad_message", message: "Unknown command." }, phaseChanged: false, dirty: [] };
    }
    const playerRow = await this.backend.get(roomPk(code), `PLAYER#${cmd.playerId}`);
    const player = playerRow?.player as Player | undefined;
    if (!player || player.kicked) {
      return { ok: false, error: { code: "not_in_room", message: "You are not in this room.", clientMsgId: "clientMsgId" in cmd ? cmd.clientMsgId : undefined }, phaseChanged: false, dirty: [] };
    }
    player.buckets = player.buckets ?? freshBuckets();
    if (cmd.type === "board.cursor") {
      if (!take(player.buckets.cursor, now, 12, 1000)) {
        return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: [] };
      }
      const team = env.config.teams.find((t) => t.id === player.teamId);
      const cursor: Cursor = {
        playerId: player.id,
        name: player.name,
        color: team?.color ?? "#FF9900",
        x: Math.min(100, Math.max(0, cmd.x)),
        y: Math.min(100, Math.max(0, cmd.y)),
        ts: now,
      };
      await this.backend.put({ pk: roomPk(code), sk: `CURSOR#${player.id}`, cursor, ttl: this.backend.ttl(1) });
      player.lastSeen = now;
      player.connected = true;
      await this.backend.put(playerItem(code, player, this.backend.ttl()));
      return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["cursors"] };
    }

    const meta = await this.backend.get(roomPk(code), "META");
    if (meta?.boardLocked) {
      return { ok: false, error: { code: "board_locked", message: "The host locked the board.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
    }
    if (!take(player.buckets.board, now, env.config.board.rateLimitPerSec, 1000)) {
      return { ok: false, error: { code: "slow", message: "Slow down a little.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
    }

    if (cmd.type === "board.place") {
      if (!env.config.board.tiles.some((t) => t.id === cmd.tileType)) {
        return { ok: false, error: { code: "bad_tile", message: "Unknown service tile.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const counters = await this.backend.get(roomPk(code), "COUNTERS");
        if (!counters) return { ok: false, error: { code: "room_not_found", message: "No room with that code.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        if (Number(counters.nodes ?? 0) >= env.config.board.maxNodes) {
          return { ok: false, error: { code: "board_full", message: "The board is full.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        }
        const nextSeq = Number(counters.seq ?? 0) + 1;
        const nodeId = `n${nextSeq.toString(36)}`;
        const counted = await this.backend.put(
          { ...counters, pk: roomPk(code), sk: "COUNTERS", seq: nextSeq, nodes: Number(counters.nodes ?? 0) + 1, ttl: this.backend.ttl() },
          "seq = :seq AND nodes = :nodes",
          { ":seq": Number(counters.seq ?? 0), ":nodes": Number(counters.nodes ?? 0) },
        );
        if (counted === "conflict") {
          await sleep(jitter(attempt));
          continue;
        }
        const node: BoardNode = {
          id: nodeId,
          tileType: cmd.tileType,
          x: Math.min(100, Math.max(0, cmd.x)),
          y: Math.min(100, Math.max(0, cmd.y)),
          by: player.id,
          byName: player.name,
        };
        await this.backend.put({ pk: roomPk(code), sk: `NODE#${nodeId}`, node, ttl: this.backend.ttl() });
        player.lastSeen = now;
        player.lastAction = now;
        player.connected = true;
        await this.backend.put(playerItem(code, player, this.backend.ttl()));
        return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["board", "admin"] };
      }
      return { ok: false, error: { code: "busy", message: "The board is busy. Try again.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
    }

    if (cmd.type === "board.move") {
      const row = await this.backend.get(roomPk(code), `NODE#${cmd.nodeId}`);
      if (!row?.node) return { ok: false, error: { code: "missing", message: "That tile is gone.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      const node = row.node as BoardNode;
      node.x = Math.min(100, Math.max(0, cmd.x));
      node.y = Math.min(100, Math.max(0, cmd.y));
      await this.backend.put({ pk: roomPk(code), sk: `NODE#${cmd.nodeId}`, node, ttl: this.backend.ttl() });
      return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["board", "admin"] };
    }

    if (cmd.type === "board.connect") {
      if (cmd.from === cmd.to) {
        return { ok: false, error: { code: "bad_edge", message: "Pick two different tiles.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      }
      const a = await this.backend.get(roomPk(code), `NODE#${cmd.from}`);
      const b = await this.backend.get(roomPk(code), `NODE#${cmd.to}`);
      if (!a?.node || !b?.node) {
        return { ok: false, error: { code: "missing", message: "That tile is gone.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      }
      const edgeKey = [cmd.from, cmd.to].sort().join(":");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const counters = await this.backend.get(roomPk(code), "COUNTERS");
        if (!counters) return { ok: false, error: { code: "room_not_found", message: "No room with that code.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        if (Number(counters.edges ?? 0) >= env.config.board.maxEdges) {
          return { ok: false, error: { code: "board_full", message: "The board is full.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        }
        const nextSeq = Number(counters.seq ?? 0) + 1;
        const edgeId = `e${nextSeq.toString(36)}`;
        const edgePut = await this.backend.put(
          {
            pk: roomPk(code),
            sk: `EDGEKEY#${edgeKey}`,
            edgeId,
            ttl: this.backend.ttl(),
          },
          "attribute_not_exists(pk)",
        );
        if (edgePut === "conflict") {
          return { ok: false, error: { code: "bad_edge", message: "Those tiles are already connected.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        }
        const counted = await this.backend.put(
          { ...counters, pk: roomPk(code), sk: "COUNTERS", seq: nextSeq, edges: Number(counters.edges ?? 0) + 1, ttl: this.backend.ttl() },
          "seq = :seq AND edges = :edges",
          { ":seq": Number(counters.seq ?? 0), ":edges": Number(counters.edges ?? 0) },
        );
        if (counted === "conflict") {
          await this.backend.remove(roomPk(code), `EDGEKEY#${edgeKey}`);
          await sleep(jitter(attempt));
          continue;
        }
        const edge: BoardEdge = { id: edgeId, from: cmd.from, to: cmd.to, by: player.id };
        await this.backend.put({ pk: roomPk(code), sk: `EDGE#${edgeId}`, edge, ttl: this.backend.ttl() });
        return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["board", "admin"] };
      }
      return { ok: false, error: { code: "busy", message: "The board is busy. Try again.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
    }

    // delete
    const nodeRow = await this.backend.get(roomPk(code), `NODE#${cmd.nodeId}`);
    if (nodeRow) await this.backend.remove(roomPk(code), `NODE#${cmd.nodeId}`);
    const all = await this.backend.query(roomPk(code), "EDGE");
    for (const item of all) {
      const edge = item.edge as BoardEdge | undefined;
      if (!edge) continue;
      if (edge.from === cmd.nodeId || edge.to === cmd.nodeId) {
        await this.backend.remove(roomPk(code), String(item.sk));
        const key = [edge.from, edge.to].sort().join(":");
        await this.backend.remove(roomPk(code), `EDGEKEY#${key}`);
      }
    }
    return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["board", "admin"] };
  }

  private async qa(code: string, cmd: Command, now: number, env: EngineEnv): Promise<ApplyResult> {
    if (cmd.type !== "qa.post" && cmd.type !== "qa.upvote") {
      return { ok: false, error: { code: "bad_message", message: "Unknown command." }, phaseChanged: false, dirty: [] };
    }
    const playerRow = await this.backend.get(roomPk(code), `PLAYER#${cmd.playerId}`);
    const player = playerRow?.player as Player | undefined;
    if (!player || player.kicked) {
      return { ok: false, error: { code: "not_in_room", message: "You are not in this room.", clientMsgId: cmd.type === "qa.post" ? cmd.clientMsgId : undefined }, phaseChanged: false, dirty: [] };
    }
    player.buckets = player.buckets ?? freshBuckets();
    if (cmd.type === "qa.post") {
      const cleaned = assertCleanText(cmd.text, env.config.qa.maxQuestionLength);
      if (!cleaned.ok) {
        return { ok: false, error: { code: "bad_text", message: cleaned.message, clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      }
      if (!take(player.buckets.qa, now, env.config.qa.rateLimitPerMin, 60_000)) {
        return { ok: false, error: { code: "slow", message: "Give it a minute before the next question.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const counters = await this.backend.get(roomPk(code), "COUNTERS");
        if (!counters) return { ok: false, error: { code: "room_not_found", message: "No room with that code.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
        const nextSeq = Number(counters.seq ?? 0) + 1;
        const id = `q${nextSeq.toString(36)}`;
        const counted = await this.backend.put(
          { ...counters, pk: roomPk(code), sk: "COUNTERS", seq: nextSeq, ttl: this.backend.ttl() },
          "seq = :seq",
          { ":seq": Number(counters.seq ?? 0) },
        );
        if (counted === "conflict") {
          await sleep(jitter(attempt));
          continue;
        }
        const qa: QaItem = {
          id,
          text: cleaned.text,
          by: player.id,
          byName: player.name,
          upvotes: 0,
          voters: [],
          answered: false,
          hidden: false,
          createdAt: now,
        };
        await this.backend.put({ pk: roomPk(code), sk: `QA#${id}`, qa, ttl: this.backend.ttl() });
        player.lastSeen = now;
        player.lastAction = now;
        await this.backend.put(playerItem(code, player, this.backend.ttl()));
        return { ok: true, clientMsgId: cmd.clientMsgId, phaseChanged: false, dirty: ["qa", "admin"] };
      }
      return { ok: false, error: { code: "busy", message: "Try again.", clientMsgId: cmd.clientMsgId }, phaseChanged: false, dirty: [] };
    }
    if (!take(player.buckets.vote, now, 8, 1000)) {
      return { ok: false, error: { code: "slow", message: "Slow down a little." }, phaseChanged: false, dirty: [] };
    }
    const row = await this.backend.get(roomPk(code), `QA#${cmd.questionId}`);
    const item = row?.qa as QaItem | undefined;
    if (!item || item.hidden) return { ok: false, error: { code: "missing", message: "That question is gone." }, phaseChanged: false, dirty: [] };
    if (item.voters.includes(player.id)) {
      item.voters = item.voters.filter((id) => id !== player.id);
      item.upvotes = Math.max(0, item.upvotes - 1);
    } else {
      item.voters.push(player.id);
      item.upvotes += 1;
    }
    await this.backend.put({ pk: roomPk(code), sk: `QA#${item.id}`, qa: item, ttl: this.backend.ttl() });
    return { ok: true, phaseChanged: false, dirty: ["qa", "admin"] };
  }

  private async matchSet(code: string, playerId: string, interests: string[], now: number, env: EngineEnv): Promise<ApplyResult> {
    const playerRow = await this.backend.get(roomPk(code), `PLAYER#${playerId}`);
    const player = playerRow?.player as Player | undefined;
    if (!player || player.kicked) {
      return { ok: false, error: { code: "not_in_room", message: "You are not in this room." }, phaseChanged: false, dirty: [] };
    }
    const allowed = new Set(env.config.match.interests);
    const cleaned = [...new Set(interests.filter((i) => allowed.has(i)))].slice(0, 8);
    await this.backend.put({ pk: roomPk(code), sk: `INTEREST#${playerId}`, interests: cleaned, ttl: this.backend.ttl() });
    player.lastSeen = now;
    player.lastAction = now;
    await this.backend.put(playerItem(code, player, this.backend.ttl()));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const room = await this.loadRoom(code);
      if (!room) return { ok: false, error: { code: "room_not_found", message: "No room with that code." }, phaseChanged: false, dirty: [] };
      room.interests[playerId] = cleaned;
      const working = structuredClone(room);
      const result = apply(working, { type: "match.set", playerId, interests: cleaned }, now, env);
      const saved = await this.backend.put(
        { pk: roomPk(code), sk: "META", ...metaFromState(working), ttl: this.backend.ttl() },
        "version = :v",
        { ":v": room.version },
      );
      if (saved === "conflict") {
        await sleep(jitter(attempt));
        continue;
      }
      return { ok: true, phaseChanged: false, dirty: result.dirty.length ? result.dirty : ["match", "admin"] };
    }
    return { ok: false, error: { code: "busy", message: "Matching is busy. Try again." }, phaseChanged: false, dirty: [] };
  }

  async hostMutate(code: string, cmd: Command, now: number, env: EngineEnv): Promise<ApplyResult> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.loadRoom(code);
      if (!current) return { ok: false, error: { code: "room_not_found", message: "Open a room first." }, phaseChanged: false, dirty: [] };
      const working = structuredClone(current);
      const result = apply(working, cmd, now, env);
      if (!result.ok) return result;
      const changed =
        result.phaseChanged ||
        result.modeChanged ||
        result.dirty.length > 0 ||
        result.joined ||
        result.answer ||
        result.clientMsgId ||
        result.kicked;
      if (!changed) return result;

      const saved = await this.commitHost(current, working, env, cmd);
      if (!saved) {
        await sleep(jitter(attempt));
        continue;
      }
      return result;
    }
    return {
      ok: false,
      error: { code: "busy", message: "The host controls are busy. Try again." },
      phaseChanged: false,
      dirty: [],
    };
  }

  private async wipePrefix(code: string, prefix: string): Promise<void> {
    const items = await this.backend.query(roomPk(code), prefix);
    for (const item of items) await this.backend.remove(roomPk(code), String(item.sk));
  }

  private async commitHost(previous: RoomState, next: RoomState, env: EngineEnv, cmd: Command): Promise<boolean> {
    const status = await this.backend.put(
      { pk: roomPk(next.code), sk: "META", ...metaFromState(next), ttl: this.backend.ttl() },
      "version = :v",
      { ":v": previous.version },
    );
    if (status === "conflict") return false;

    if (cmd.type === "host.reset") {
      const items = await this.backend.query(roomPk(next.code), "");
      for (const item of items) {
        const sk = String(item.sk);
        if (sk === "META" || sk === "COUNTERS" || sk.startsWith("CONN#") || sk.startsWith("LOCK#")) continue;
        await this.backend.remove(roomPk(next.code), sk);
      }
      await this.backend.put({
        pk: roomPk(next.code),
        sk: "COUNTERS",
        seq: next.seq,
        joined: Object.values(next.players).filter((p) => !p.kicked).length,
        nodes: 0,
        edges: 0,
        teams: Object.fromEntries(
          env.config.teams.map((team) => [team.id, Object.values(next.players).filter((p) => !p.kicked && p.teamId === team.id).length]),
        ),
        ttl: this.backend.ttl(),
      });
      for (const player of Object.values(next.players)) {
        player.score = 0;
        player.answers = {};
        player.kicked = false;
        await this.backend.put(playerItem(next.code, player, this.backend.ttl()));
        await this.backend.put({ pk: roomPk(next.code), sk: `DEVICE#${player.deviceId}`, playerId: player.id, ttl: this.backend.ttl() });
        await this.backend.put({
          pk: roomPk(next.code),
          sk: `NAME#${player.name.toLowerCase()}`,
          playerId: player.id,
          ttl: this.backend.ttl(),
        });
        await this.backend.put({
          pk: roomPk(next.code),
          sk: `TEAM#${player.teamId}`,
          members: Object.values(next.players).filter((p) => !p.kicked && p.teamId === player.teamId).length,
          score: 0,
          ttl: this.backend.ttl(),
        });
      }
      return true;
    }

    const scoresCleared = Object.values(next.players).some((p) => {
      const prev = previous.players[p.id];
      return prev && prev.score > 0 && p.score === 0 && Object.keys(p.answers).length === 0;
    });
    if (scoresCleared || (cmd.type === "host.start" && previous.battle.phase === "finished")) {
      await this.wipePrefix(next.code, "ANSWER#");
      for (const team of env.config.teams) {
        await this.backend.put({
          pk: roomPk(next.code),
          sk: `TEAM#${team.id}`,
          members: Object.values(next.players).filter((p) => !p.kicked && p.teamId === team.id).length,
          score: 0,
          ttl: this.backend.ttl(),
        });
      }
    }

    for (const player of Object.values(next.players)) {
      const prev = previous.players[player.id];
      if (!prev || JSON.stringify({ ...prev, answers: null }) !== JSON.stringify({ ...player, answers: null })) {
        await this.backend.put(playerItem(next.code, player, this.backend.ttl()));
      }
    }

    if (cmd.type === "host.board.clear" || (next.board.nodes.length === 0 && previous.board.nodes.length > 0)) {
      await this.wipePrefix(next.code, "NODE");
      await this.wipePrefix(next.code, "EDGE");
      await this.wipePrefix(next.code, "EDGEKEY");
      await this.wipePrefix(next.code, "CURSOR");
      const counters = await this.backend.get(roomPk(next.code), "COUNTERS");
      if (counters) {
        await this.backend.put({ ...counters, pk: roomPk(next.code), sk: "COUNTERS", nodes: 0, edges: 0, ttl: this.backend.ttl() });
      }
    }

    if (cmd.type === "host.kick") {
      await this.backend.remove(roomPk(next.code), `CURSOR#${cmd.playerId}`);
      await this.backend.remove(roomPk(next.code), `INTEREST#${cmd.playerId}`);
    }

    for (const item of next.qa) {
      const prev = previous.qa.find((q) => q.id === item.id);
      if (!prev || prev.answered !== item.answered || prev.hidden !== item.hidden || prev.upvotes !== item.upvotes) {
        await this.backend.put({ pk: roomPk(next.code), sk: `QA#${item.id}`, qa: item, ttl: this.backend.ttl() });
      }
    }
    return true;
  }

  async putConnection(roomCode: string, connectionId: string, fields: Record<string, unknown>): Promise<void> {
    const ttl = this.backend.ttl();
    const existing = await this.backend.get(`CONN#${connectionId}`, "META");
    const merged = { ...(existing ?? {}), ...fields, roomCode, ttl };
    await this.backend.put({ pk: roomPk(roomCode), sk: `CONN#${connectionId}`, ...merged, ttl });
    await this.backend.put({ pk: `CONN#${connectionId}`, sk: "META", ...merged, ttl });
  }

  async updateConnectionViews(connectionId: string, views: string[]): Promise<void> {
    const existing = await this.backend.get(`CONN#${connectionId}`, "META");
    if (!existing?.roomCode) return;
    await this.putConnection(String(existing.roomCode), connectionId, { ...existing, views });
  }

  async deleteConnection(connectionId: string): Promise<{ roomCode?: string; playerId?: string; role?: string }> {
    const got = await this.backend.get(`CONN#${connectionId}`, "META");
    const roomCode = got?.roomCode as string | undefined;
    const playerId = got?.playerId as string | undefined;
    const role = got?.role as string | undefined;
    await this.backend.remove(`CONN#${connectionId}`, "META");
    if (roomCode) await this.backend.remove(roomPk(roomCode), `CONN#${connectionId}`);
    return { roomCode, playerId, role };
  }

  async listConnections(roomCode: string): Promise<ConnRow[]> {
    const rows = await this.backend.query(roomPk(roomCode), "CONN#");
    return rows.map((item) => ({
      id: String(item.sk).slice("CONN#".length),
      role: item.role as string | undefined,
      playerId: item.playerId as string | undefined,
      deviceId: item.deviceId as string | undefined,
      views: item.views as string[] | undefined,
    }));
  }

  async getConnection(connectionId: string): Promise<Record<string, unknown> | null> {
    return this.backend.get(`CONN#${connectionId}`, "META");
  }

  async broadcastLock(roomCode: string, kind: string, gapMs: number): Promise<boolean> {
    const now = Date.now();
    const existing = await this.backend.get(roomPk(roomCode), `LOCK#${kind}`);
    if (existing && Number(existing.until ?? 0) > now) return false;
    const status = await this.backend.put(
      { pk: roomPk(roomCode), sk: `LOCK#${kind}`, until: now + gapMs, ttl: this.backend.ttl() },
      "attribute_not_exists(until) OR until < :now",
      { ":now": now },
    );
    return status === "ok";
  }

  async loginAllowed(ip: string, now: number, maxFails: number, windowMs: number): Promise<boolean> {
    const got = await this.backend.get("LOGIN", ip);
    if (!got) return true;
    if (Number(got.lockUntil ?? 0) > now) return false;
    if (now - Number(got.windowStart ?? 0) > windowMs) return true;
    return Number(got.fails ?? 0) < maxFails;
  }

  async loginFail(ip: string, now: number, maxFails: number, windowMs: number, lockMs: number): Promise<void> {
    const got = await this.backend.get("LOGIN", ip);
    let fails = Number(got?.fails ?? 0);
    let windowStart = Number(got?.windowStart ?? now);
    if (now - windowStart > windowMs) {
      fails = 0;
      windowStart = now;
    }
    fails += 1;
    await this.backend.put({
      pk: "LOGIN",
      sk: ip,
      fails,
      windowStart,
      lockUntil: fails >= maxFails ? now + lockMs : 0,
      ttl: this.backend.ttl(1),
    });
  }

  async loginSuccess(ip: string): Promise<void> {
    await this.backend.remove("LOGIN", ip);
  }
}

export { createRoom, emptyBattle };
