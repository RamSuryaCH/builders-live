// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { apply, createRoom, type ApplyResult, type Command, type EngineEnv } from "../shared/engine.js";
import { loadConfig, validateConfig } from "../shared/event-config.js";
import { loadQuestions, validateQuestions } from "../shared/questions.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { roomCodeOk } from "../shared/protocol.js";
import { hashSecret, issueToken, readToken, verifySecret } from "../shared/tokens.js";
import { LoginThrottle } from "../shared/throttle.js";
import type { Features, RoomState } from "../shared/types.js";
import {
  adminView,
  battleView,
  boardView,
  cursorsView,
  groupsView,
  lobbyView,
  playerView,
  qaView,
  screenView,
  standingsView,
} from "../shared/views.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Meta {
  role: "pending" | "player" | "host" | "screen";
  roomCode?: string;
  playerId?: string;
  deviceId?: string;
  ip: string;
  views: Set<string>;
}

interface Runtime {
  state: RoomState;
  conns: Set<WebSocket>;
  timer?: NodeJS.Timeout;
  dirty: Set<string>;
  lastAdmin: number;
  lastStandings: number;
}

export interface LocalOptions {
  port?: number;
  host?: string;
  adminSecret?: string;
  signingKey?: string;
  staticDir?: string | null;
  features?: Features;
  onRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

function mime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

export async function startLocalServer(opts: LocalOptions = {}): Promise<RunningServer> {
  const config = loadConfig();
  const questions = loadQuestions();
  const problems = [...validateConfig(config), ...validateQuestions(questions, config)];
  if (problems.length) throw new Error(problems.join("; "));
  const env: EngineEnv = { config, questions };
  const features: Features = opts.features ?? {
    bedrockSummary: process.env.ENABLE_BEDROCK_SUMMARY === "true",
  };
  const signingKey = opts.signingKey ?? process.env.SIGNING_KEY ?? "local-dev-signing-key";
  const secretHash = hashSecret(opts.adminSecret ?? process.env.ADMIN_SECRET ?? "local-dev-pin");
  const throttle = new LoginThrottle(
    config.login.maxFailures,
    config.login.windowSeconds * 1000,
    config.login.lockoutSeconds * 1000,
  );
  const rooms = new Map<string, Runtime>();

  const metaOf = (ws: WebSocket): Meta => (ws as WebSocket & { meta: Meta }).meta;

  function send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function broadcast(room: Runtime, msg: ServerMessage, filter: (meta: Meta) => boolean): void {
    const raw = JSON.stringify(msg);
    for (const ws of room.conns) {
      if (ws.readyState !== 1) continue;
      if (filter(metaOf(ws))) ws.send(raw);
    }
  }

  function pushPhase(room: Runtime): void {
    const now = Date.now();
    broadcast(
      room,
      {
        type: "battle",
        battle: battleView(room.state, env),
        standings: standingsView(room.state, config),
        screenMode: room.state.screenMode,
        serverTs: now,
      },
      () => true,
    );
  }

  function pushLobby(room: Runtime): void {
    const now = Date.now();
    broadcast(
      room,
      { type: "lobby", lobby: lobbyView(room.state, config), serverTs: now },
      (m) => m.role === "host" || m.role === "screen",
    );
  }

  let arm: (room: Runtime, at: number | null | undefined) => void;

  function applySideEffects(room: Runtime, result: ApplyResult, actor: WebSocket | null, clientTs?: number): void {
    const now = Date.now();
    if (!result.ok && result.error && actor) {
      send(actor, { type: "error", ...result.error, serverTs: now });
    }
    if (result.answer && actor) {
      send(actor, { type: "answer.ack", ack: result.answer, serverTs: now, clientTs });
    } else if (result.ok && result.clientMsgId && actor) {
      send(actor, { type: "ack", clientMsgId: result.clientMsgId, serverTs: now, clientTs });
    }
    if (result.kicked) {
      for (const ws of room.conns) {
        const meta = metaOf(ws);
        if (meta.playerId === result.kicked.playerId && meta.role === "player") {
          send(ws, { type: "kicked", message: result.kicked.message, serverTs: now });
          meta.role = "pending";
          meta.playerId = undefined;
        }
      }
    }
    if (result.phaseChanged) pushPhase(room);
    if (result.modeChanged) {
      broadcast(
        room,
        { type: "mode", screenMode: room.state.screenMode, serverTs: now },
        () => true,
      );
    }
    for (const key of result.dirty) room.dirty.add(key);
    if (result.dirty.includes("lobby")) pushLobby(room);
    if (result.scheduleAt !== undefined) arm(room, result.scheduleAt);
  }

  arm = (room, at) => {
    if (at === undefined) return;
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
    if (at == null) return;
    const generation = room.state.battle.generation;
    const wait = Math.max(0, at - Date.now());
    room.timer = setTimeout(() => {
      if (room.state.battle.generation !== generation) return;
      const result = apply(room.state, { type: "tick" }, Date.now(), env);
      applySideEffects(room, result, null);
    }, wait);
  };

  function flushRoom(room: Runtime, now: number): void {
    if (room.dirty.has("standings") && now - room.lastStandings >= 250) {
      room.lastStandings = now;
      room.dirty.delete("standings");
      broadcast(
        room,
        { type: "standings", standings: standingsView(room.state, config), serverTs: now },
        (m) => m.role === "host" || m.role === "screen",
      );
    }
    if (room.dirty.has("board")) {
      room.dirty.delete("board");
      const board = boardView(room.state, config);
      broadcast(
        room,
        { type: "board", board, serverTs: now },
        (m) => m.role === "host" || m.role === "screen" || m.views.has("board"),
      );
    }
    if (room.dirty.has("cursors")) {
      room.dirty.delete("cursors");
      const cursors = cursorsView(room.state, now);
      broadcast(
        room,
        { type: "cursors", cursors, serverTs: now },
        (m) => m.role === "host" || m.role === "screen" || m.views.has("board"),
      );
    }
    if (room.dirty.has("qa")) {
      room.dirty.delete("qa");
      for (const ws of room.conns) {
        const meta = metaOf(ws);
        if (meta.role === "pending") continue;
        send(ws, { type: "qa", items: qaView(room.state, meta.playerId ?? null, meta.role === "host"), serverTs: now });
      }
    }
    if (room.dirty.has("match")) {
      room.dirty.delete("match");
      for (const ws of room.conns) {
        const meta = metaOf(ws);
        if (meta.role === "player") {
          const groups = groupsView(room.state, meta.playerId ?? null);
          send(ws, { type: "match", yours: groups.find((g) => g.yours) ?? null, serverTs: now });
        } else if (meta.role === "host" || meta.role === "screen") {
          send(ws, { type: "match", yours: null, groups: groupsView(room.state, null), serverTs: now });
        }
      }
    }
    if (room.dirty.has("admin") && now - room.lastAdmin >= 400) {
      room.lastAdmin = now;
      room.dirty.delete("admin");
      const admin = adminView(room.state, env, now, features);
      broadcast(room, { type: "admin", admin, serverTs: now }, (m) => m.role === "host");
    }
    room.dirty.delete("lobby");
  }

  const flushEvery = Math.round(1000 / config.board.broadcastHz);
  const flusher = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) flushRoom(room, now);
  }, flushEvery);

  function unlink(ws: WebSocket, playerLeft: boolean): void {
    const meta = metaOf(ws);
    if (!meta.roomCode) return;
    const room = rooms.get(meta.roomCode);
    const playerId = meta.playerId;
    const role = meta.role;
    meta.roomCode = undefined;
    if (!room) return;
    room.conns.delete(ws);
    if (playerLeft && role === "player" && playerId) {
      const still = [...room.conns].some((other) => metaOf(other).playerId === playerId && metaOf(other).role === "player");
      if (!still) {
        const result = apply(room.state, { type: "disconnect", playerId }, Date.now(), env);
        applySideEffects(room, result, null);
      }
    }
  }

  function newCode(): string {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const bytes = randomBytes(6);
      let code = "";
      for (let i = 0; i < 6; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
      if (!rooms.has(code)) return code;
    }
    throw new Error("Could not allocate a room code");
  }

  function hostOk(ws: WebSocket, token: string | undefined, now: number): boolean {
    if (!token) {
      send(ws, { type: "error", code: "unauthorized", message: "Host session required.", serverTs: now });
      return false;
    }
    const payload = readToken(token, signingKey, now);
    if (!payload || payload.r !== "h") {
      send(ws, { type: "error", code: "unauthorized", message: "Host session expired. Enter the PIN again.", serverTs: now });
      return false;
    }
    metaOf(ws).role = "host";
    return true;
  }

  function commandFor(msg: ClientMessage): Command | null {
    switch (msg.type) {
      case "host.lock":
        return { type: "host.lock", locked: msg.locked };
      case "host.mode":
        return { type: "host.mode", mode: msg.mode };
      case "host.reset":
        return { type: "host.reset" };
      case "host.start":
        return { type: "host.start" };
      case "host.pause":
        return { type: "host.pause" };
      case "host.resume":
        return { type: "host.resume" };
      case "host.skip":
        return { type: "host.skip" };
      case "host.skipRound":
        return { type: "host.skipRound" };
      case "host.stop":
        return { type: "host.stop" };
      case "host.kick":
        return { type: "host.kick", playerId: msg.playerId, block: msg.block };
      case "host.board.clear":
        return { type: "host.board.clear" };
      case "host.board.lock":
        return { type: "host.board.lock", locked: msg.locked };
      case "host.board.challenge":
        return { type: "host.board.challenge", challengeId: msg.challengeId };
      case "host.qa.answered":
        return { type: "host.qa.answered", questionId: msg.questionId, answered: msg.answered };
      case "host.qa.hide":
        return { type: "host.qa.hide", questionId: msg.questionId, hidden: msg.hidden };
      default:
        return null;
    }
  }

  function onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      send(ws, { type: "error", code: "bad_json", message: "That message was not valid JSON.", serverTs: Date.now() });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      send(ws, { type: "error", code: "bad_message", message: "Missing message type.", serverTs: Date.now() });
      return;
    }
    const now = Date.now();
    const meta = metaOf(ws);
    const clientTs = "clientTs" in msg ? msg.clientTs : undefined;

    if (msg.type === "ping") {
      const room = meta.roomCode ? rooms.get(meta.roomCode) : undefined;
      if (room && meta.role === "player" && meta.playerId) {
        applySideEffects(room, apply(room.state, { type: "heartbeat", playerId: meta.playerId }, now, env), ws);
        applySideEffects(room, apply(room.state, { type: "tick" }, now, env), null);
        if (msg.v != null && msg.v !== room.state.version) {
          const player = room.state.players[meta.playerId];
          if (player && !player.kicked) {
            send(ws, { type: "state", role: "player", state: playerView(room.state, env, meta.playerId, now, features), serverTs: now });
          }
        }
      } else if (room) {
        applySideEffects(room, apply(room.state, { type: "tick" }, now, env), null);
      }
      send(ws, { type: "pong", clientTs: msg.clientTs, serverTs: now, version: room?.state.version ?? 0 });
      return;
    }

    if (msg.type === "host.login") {
      if (!throttle.allowed(meta.ip, now)) {
        send(ws, { type: "error", code: "throttled", message: "Too many attempts. Wait a few minutes and try again.", serverTs: now });
        return;
      }
      if (!verifySecret(String(msg.secret ?? ""), secretHash)) {
        throttle.fail(meta.ip, now);
        send(ws, { type: "error", code: "bad_pin", message: "That host PIN is not right.", serverTs: now });
        return;
      }
      throttle.success(meta.ip);
      const exp = now + config.hostSessionHours * 3_600_000;
      const token = issueToken({ r: "h", exp }, signingKey);
      meta.role = "host";
      send(ws, { type: "host.welcome", token, expiresAt: exp, features, serverTs: now });
      return;
    }

    if (msg.type === "host.createRoom") {
      if (!hostOk(ws, msg.token, now)) return;
      const code = newCode();
      const state = createRoom(code, now);
      const room: Runtime = { state, conns: new Set(), dirty: new Set(), lastAdmin: 0, lastStandings: 0 };
      rooms.set(code, room);
      unlink(ws, false);
      meta.role = "host";
      meta.roomCode = code;
      room.conns.add(ws);
      send(ws, { type: "room.created", roomCode: code, joinPath: `/join/${code}`, screenPath: `/screen/${code}`, serverTs: now });
      send(ws, { type: "state", role: "host", state: adminView(state, env, now, features), serverTs: now });
      return;
    }

    if (msg.type === "host.attach") {
      if (!hostOk(ws, msg.token, now)) return;
      const code = String(msg.roomCode ?? "").toUpperCase();
      const room = rooms.get(code);
      if (!room || !roomCodeOk(code)) {
        send(ws, { type: "error", code: "room_not_found", message: "No room with that code.", serverTs: now });
        return;
      }
      unlink(ws, false);
      meta.role = "host";
      meta.roomCode = code;
      room.conns.add(ws);
      send(ws, { type: "state", role: "host", state: adminView(room.state, env, now, features), serverTs: now });
      return;
    }

    if (msg.type === "host.snapshot") {
      if (!hostOk(ws, msg.token, now)) return;
      const room = meta.roomCode ? rooms.get(meta.roomCode) : undefined;
      if (!room) {
        send(ws, { type: "error", code: "room_not_found", message: "Open a room first.", serverTs: now });
        return;
      }
      send(ws, { type: "admin", admin: adminView(room.state, env, now, features), serverTs: now, clientTs });
      return;
    }

    if (msg.type === "host.summarise") {
      if (!hostOk(ws, msg.token, now)) return;
      if (!features.bedrockSummary) {
        send(ws, { type: "error", code: "disabled", message: "Summaries are turned off for this deploy.", serverTs: now });
        return;
      }
      send(ws, {
        type: "error",
        code: "disabled",
        message: "Summaries run in the optional Bedrock Lambda, which is not part of local mode.",
        serverTs: now,
      });
      return;
    }

    if (msg.type === "screen.join") {
      const code = String(msg.roomCode ?? "").toUpperCase();
      const room = rooms.get(code);
      if (!room || !roomCodeOk(code)) {
        send(ws, { type: "error", code: "room_not_found", message: "No room with that code.", serverTs: now });
        return;
      }
      unlink(ws, true);
      meta.role = "screen";
      meta.roomCode = code;
      room.conns.add(ws);
      send(ws, { type: "state", role: "screen", state: screenView(room.state, env, now, features), serverTs: now });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.roomCode ?? "").toUpperCase();
      const room = rooms.get(code);
      if (!room || !roomCodeOk(code)) {
        send(ws, { type: "error", code: "room_not_found", message: "No room with that code. Check the projector.", serverTs: now });
        return;
      }
      unlink(ws, true);
      const result = apply(room.state, { type: "join", name: String(msg.displayName ?? ""), deviceId: String(msg.deviceId ?? "") }, now, env);
      if (!result.ok || !result.joined) {
        applySideEffects(room, result, ws, clientTs);
        return;
      }
      const player = room.state.players[result.joined.playerId];
      const exp = now + config.sessionTtlHours * 3_600_000;
      const token = issueToken({ r: "p", exp, room: code, pid: player.id, did: player.deviceId }, signingKey);
      meta.role = "player";
      meta.roomCode = code;
      meta.playerId = player.id;
      meta.deviceId = player.deviceId;
      room.conns.add(ws);
      send(ws, {
        type: "welcome",
        token,
        playerId: player.id,
        roomCode: code,
        state: playerView(room.state, env, player.id, now, features),
        serverTs: now,
        clientTs,
      });
      applySideEffects(room, result, null);
      return;
    }

    if (msg.type === "resume") {
      const payload = readToken(String(msg.token ?? ""), signingKey, now);
      if (!payload || payload.r !== "p") {
        send(ws, { type: "error", code: "unauthorized", message: "Session expired. Join again with your name.", serverTs: now });
        return;
      }
      const room = rooms.get(payload.room);
      if (!room) {
        send(ws, { type: "error", code: "room_not_found", message: "That room has ended.", serverTs: now });
        return;
      }
      unlink(ws, true);
      const result = apply(room.state, { type: "resume", playerId: payload.pid, deviceId: String(msg.deviceId ?? payload.did) }, now, env);
      if (!result.ok || !result.joined) {
        applySideEffects(room, result, ws, clientTs);
        return;
      }
      meta.role = "player";
      meta.roomCode = payload.room;
      meta.playerId = payload.pid;
      meta.deviceId = payload.did;
      room.conns.add(ws);
      send(ws, {
        type: "welcome",
        token: msg.token,
        playerId: payload.pid,
        roomCode: payload.room,
        state: playerView(room.state, env, payload.pid, now, features),
        serverTs: now,
        clientTs,
      });
      applySideEffects(room, result, null);
      return;
    }

    if (msg.type === "subscribe") {
      meta.views = new Set(Array.isArray(msg.views) ? msg.views : []);
      const room = meta.roomCode ? rooms.get(meta.roomCode) : undefined;
      if (room && meta.role === "player" && meta.playerId && room.state.players[meta.playerId]) {
        send(ws, { type: "state", role: "player", state: playerView(room.state, env, meta.playerId, now, features), serverTs: now });
      }
      return;
    }

    if (meta.role === "player" && meta.playerId && meta.roomCode) {
      const room = rooms.get(meta.roomCode);
      if (!room) {
        send(ws, { type: "error", code: "room_not_found", message: "That room has ended.", serverTs: now });
        return;
      }
      const cmd = playerCommand(msg, meta.playerId);
      if (!cmd) {
        send(ws, { type: "error", code: "bad_message", message: "Players cannot do that.", serverTs: now });
        return;
      }
      const result = apply(room.state, cmd, now, env);
      applySideEffects(room, result, ws, clientTs);
      return;
    }

    const hostCmd = commandFor(msg);
    if (hostCmd) {
      const token = "token" in msg ? msg.token : undefined;
      if (!hostOk(ws, token, now)) return;
      const room = meta.roomCode ? rooms.get(meta.roomCode) : undefined;
      if (!room) {
        send(ws, { type: "error", code: "room_not_found", message: "Open a room first.", serverTs: now });
        return;
      }
      const result = apply(room.state, hostCmd, now, env);
      applySideEffects(room, result, ws, clientTs);
      if (result.ok) send(ws, { type: "admin", admin: adminView(room.state, env, Date.now(), features), serverTs: Date.now() });
      return;
    }

    send(ws, { type: "error", code: "unauthorized", message: "Join the room first.", serverTs: now });
  }

  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (opts.onRequest) {
      const handled = await opts.onRequest(req, res);
      if (handled) return;
    }
    if (!opts.staticDir) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const root = path.resolve(opts.staticDir);
    const requested = path.normalize(path.join(root, decodeURIComponent(url)));
    const file = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : path.join(root, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": mime(file) });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    (ws as WebSocket & { meta: Meta }).meta = { role: "pending", ip, views: new Set() };
    ws.on("message", (data) => {
      onMessage(ws, data.toString());
    });
    ws.on("close", () => unlink(ws, true));
    ws.on("error", () => unlink(ws, true));
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    close: () =>
      new Promise((resolve) => {
        clearInterval(flusher);
        for (const room of rooms.values()) {
          if (room.timer) clearTimeout(room.timer);
          for (const ws of room.conns) ws.terminate();
        }
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
        setTimeout(resolve, 250);
      }),
  };
}

function playerCommand(msg: ClientMessage, playerId: string): Command | null {
  switch (msg.type) {
    case "answer":
      return { type: "answer", playerId, questionId: msg.questionId, choiceId: msg.choiceId, clientMsgId: msg.clientMsgId };
    case "board.place":
      return { type: "board.place", playerId, tileType: msg.tileType, x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "board.move":
      return { type: "board.move", playerId, nodeId: msg.nodeId, x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "board.connect":
      return { type: "board.connect", playerId, from: msg.from, to: msg.to, clientMsgId: msg.clientMsgId };
    case "board.delete":
      return { type: "board.delete", playerId, nodeId: msg.nodeId, clientMsgId: msg.clientMsgId };
    case "board.cursor":
      return { type: "board.cursor", playerId, x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "qa.post":
      return { type: "qa.post", playerId, text: msg.text, clientMsgId: msg.clientMsgId };
    case "qa.upvote":
      return { type: "qa.upvote", playerId, questionId: msg.questionId };
    case "match.set":
      return { type: "match.set", playerId, interests: msg.interests };
    default:
      return null;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8080);
  const dist = path.join(ROOT, "frontend/dist");
  startLocalServer({ port, host: "0.0.0.0", staticDir: existsSync(dist) ? dist : null }).then((running) => {
    console.log(`Builders Live local ${running.url}`);
  });
}
