// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { apply, createRoom, type ApplyResult, type Command, type EngineEnv } from "../shared/engine.js";
import { loadConfig } from "../shared/event-config.js";
import { loadQuestions } from "../shared/questions.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { roomCodeOk } from "../shared/protocol.js";
import { issueToken, readToken, verifySecret } from "../shared/tokens.js";
import type { Features, RoomState } from "../shared/types.js";
import { adminView, battleView, boardView, cursorsView, groupsView, lobbyView, playerView, qaView, screenView, standingsView, topQuestions } from "../shared/views.js";
import { broadcastLock, commitRoom, createRoomItem, deleteConnection, listConnections, loadRoom, loginAllowed, loginFail, loginSuccess, putConnection } from "./aws-store.js";
import { post, postMany, roomFanout } from "./fanout.js";
import { loadSecrets } from "./secrets.js";

const config = loadConfig();
const env: EngineEnv = { config, questions: loadQuestions() };
const features: Features = { bedrockSummary: process.env.ENABLE_BEDROCK_SUMMARY === "true" };
const sqs = new SQSClient({});
const lambda = new LambdaClient({});
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface GwEvent {
  requestContext: { routeKey?: string; connectionId: string; identity?: { sourceIp?: string }; domainName?: string; stage?: string };
  body?: string;
}

export async function handler(event: GwEvent | { action?: string; roomCode?: string }): Promise<{ statusCode: number }> {
  if ("action" in event && event.action === "flush" && event.roomCode) {
    await flush(event.roomCode);
    return { statusCode: 200 };
  }
  const gw = event as GwEvent;
  const route = gw.requestContext.routeKey;
  const connectionId = gw.requestContext.connectionId;
  if (route === "$connect") return { statusCode: 200 };
  if (route === "$disconnect") {
    await onDisconnect(connectionId);
    return { statusCode: 200 };
  }
  let msg: ClientMessage;
  try {
    msg = JSON.parse(gw.body ?? "{}") as ClientMessage;
  } catch {
    await post(connectionId, { type: "error", code: "bad_json", message: "That message was not valid JSON.", serverTs: Date.now() });
    return { statusCode: 200 };
  }
  try {
    await onMessage(connectionId, gw.requestContext.identity?.sourceIp ?? "unknown", msg);
  } catch (err) {
    console.error(JSON.stringify({ type: msg.type, failed: true }));
    await post(connectionId, { type: "error", code: "server", message: "Something went wrong. Try again.", serverTs: Date.now() });
    void err;
  }
  return { statusCode: 200 };
}

async function onDisconnect(connectionId: string): Promise<void> {
  const meta = await deleteConnection(connectionId);
  if (!meta.roomCode || meta.role !== "player" || !meta.playerId) return;
  const still = (await listConnections(meta.roomCode)).some((c) => c.playerId === meta.playerId && c.role === "player");
  if (still) return;
  await mutate(meta.roomCode, { type: "disconnect", playerId: meta.playerId }, connectionId);
}

async function onMessage(connectionId: string, ip: string, msg: ClientMessage): Promise<void> {
  const now = Date.now();
  const secrets = await loadSecrets();
  if (msg.type === "ping") {
    const code = await findConn(connectionId);
    const pid = code ? await playerId(connectionId) : "";
    if (code && pid) await mutate(code, { type: "heartbeat", playerId: pid }, connectionId);
    if (code) await mutate(code, { type: "tick" }, connectionId);
    const room = code ? await loadRoom(code) : null;
    await post(connectionId, { type: "pong", clientTs: msg.clientTs, serverTs: now, version: room?.version ?? 0 });
    return;
  }
  if (msg.type === "host.login") {
    const allowed = await loginAllowed(ip, now, config.login.maxFailures, config.login.windowSeconds * 1000);
    if (!allowed) {
      await post(connectionId, { type: "error", code: "throttled", message: "Too many attempts. Wait a few minutes and try again.", serverTs: now });
      return;
    }
    if (!verifySecret(String(msg.secret ?? ""), secrets.hash)) {
      await loginFail(ip, now, config.login.maxFailures, config.login.windowSeconds * 1000, config.login.lockoutSeconds * 1000);
      await post(connectionId, { type: "error", code: "bad_pin", message: "That host PIN is not right.", serverTs: now });
      return;
    }
    await loginSuccess(ip);
    const exp = now + config.hostSessionHours * 3_600_000;
    await post(connectionId, { type: "host.welcome", token: issueToken({ r: "h", exp }, secrets.signing), expiresAt: exp, features, serverTs: now });
    return;
  }
  if (msg.type === "host.createRoom") {
    if (!(await hostOk(connectionId, msg.token, secrets.signing, now))) return;
    const code = newCode();
    const state = createRoom(code, now);
    await createRoomItem(state);
    await putConnection(code, connectionId, { role: "host" });
    await post(connectionId, { type: "room.created", roomCode: code, joinPath: `/join/${code}`, screenPath: `/screen/${code}`, serverTs: now });
    await post(connectionId, { type: "state", role: "host", state: adminView(state, env, now, features), serverTs: now });
    return;
  }
  const roomCode = await roomFor(connectionId, msg);
  if (!roomCode) return;
  if (msg.type === "host.summarise") {
    if (!(await hostOk(connectionId, msg.token, secrets.signing, now))) return;
    if (!features.bedrockSummary || !process.env.BEDROCK_FUNCTION_NAME) {
      await post(connectionId, { type: "error", code: "disabled", message: "Summaries are turned off for this deploy.", serverTs: now });
      return;
    }
    const room = await loadRoom(roomCode);
    if (!room) return;
    const invoked = await lambda.send(new InvokeCommand({
      FunctionName: process.env.BEDROCK_FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify({ questions: topQuestions(room, Number(process.env.BEDROCK_TOP_N || 10)) })),
    }));
    const payload = JSON.parse(Buffer.from(invoked.Payload ?? []).toString("utf8")) as { text?: string };
    await post(connectionId, { type: "summary", text: payload.text ?? "", serverTs: now });
    return;
  }
  if (msg.type === "screen.join") {
    const room = await loadRoom(roomCode);
    if (!room) return;
    await putConnection(roomCode, connectionId, { role: "screen" });
    await post(connectionId, { type: "state", role: "screen", state: screenView(room, env, now, features), serverTs: now });
    return;
  }
  if (msg.type === "host.attach" || msg.type === "host.snapshot") {
    if (!(await hostOk(connectionId, msg.token, secrets.signing, now))) return;
    const room = await loadRoom(roomCode);
    if (!room) return;
    const view = adminView(room, env, now, features);
    if (msg.type === "host.attach") {
      await putConnection(roomCode, connectionId, { role: "host" });
      await post(connectionId, { type: "state", role: "host", state: view, serverTs: now });
    } else {
      await post(connectionId, { type: "admin", admin: view, serverTs: now });
    }
    return;
  }
  const command = await commandFor(connectionId, msg, secrets.signing, now);
  if (!command) return;
  await mutate(roomCode, command, connectionId, "clientTs" in msg ? msg.clientTs : undefined);
}

async function roomFor(connectionId: string, msg: ClientMessage): Promise<string | null> {
  if (msg.type === "join" || msg.type === "screen.join" || msg.type === "host.attach") {
    const code = String("roomCode" in msg ? msg.roomCode : "").toUpperCase();
    if (!roomCodeOk(code) || !(await loadRoom(code))) {
      await post(connectionId, { type: "error", code: "room_not_found", message: "No room with that code.", serverTs: Date.now() });
      return null;
    }
    return code;
  }
  if (msg.type === "resume") {
    const secrets = await loadSecrets();
    const payload = readToken(msg.token, secrets.signing);
    return payload && payload.r === "p" ? payload.room : null;
  }
  return findConn(connectionId);
}

async function findConn(connectionId: string): Promise<string | null> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const got = await doc.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: { pk: `CONN#${connectionId}`, sk: "META" } }));
  return (got.Item?.roomCode as string | undefined) ?? null;
}

async function hostOk(connectionId: string, token: string | undefined, signing: string, now: number): Promise<boolean> {
  const payload = token ? readToken(token, signing, now) : null;
  if (!payload || payload.r !== "h") {
    await post(connectionId, { type: "error", code: "unauthorized", message: "Host session expired. Enter the PIN again.", serverTs: now });
    return false;
  }
  return true;
}

async function commandFor(connectionId: string, msg: ClientMessage, signing: string, now: number): Promise<Command | null> {
  if ("token" in msg && msg.type.startsWith("host.")) {
    if (!(await hostOk(connectionId, msg.token, signing, now))) return null;
  }
  switch (msg.type) {
    case "join":
      await putConnection(msg.roomCode.toUpperCase(), connectionId, { role: "player", deviceId: msg.deviceId });
      return { type: "join", name: msg.displayName, deviceId: msg.deviceId };
    case "resume": {
      const payload = readToken(msg.token, signing, now);
      if (!payload || payload.r !== "p") return null;
      await putConnection(payload.room, connectionId, { role: "player", playerId: payload.pid, deviceId: msg.deviceId });
      return { type: "resume", playerId: payload.pid, deviceId: msg.deviceId };
    }
    case "screen.join":
      await putConnection(msg.roomCode.toUpperCase(), connectionId, { role: "screen" });
      return null;
    case "host.attach":
      await putConnection(msg.roomCode.toUpperCase(), connectionId, { role: "host" });
      return null;
    case "answer":
      return { type: "answer", playerId: await playerId(connectionId), questionId: msg.questionId, choiceId: msg.choiceId, clientMsgId: msg.clientMsgId };
    case "board.place":
      return { type: "board.place", playerId: await playerId(connectionId), tileType: msg.tileType, x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "board.move":
      return { type: "board.move", playerId: await playerId(connectionId), nodeId: msg.nodeId, x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "board.connect":
      return { type: "board.connect", playerId: await playerId(connectionId), from: msg.from, to: msg.to, clientMsgId: msg.clientMsgId };
    case "board.delete":
      return { type: "board.delete", playerId: await playerId(connectionId), nodeId: msg.nodeId, clientMsgId: msg.clientMsgId };
    case "board.cursor":
      return { type: "board.cursor", playerId: await playerId(connectionId), x: msg.x, y: msg.y, clientMsgId: msg.clientMsgId };
    case "qa.post":
      return { type: "qa.post", playerId: await playerId(connectionId), text: msg.text, clientMsgId: msg.clientMsgId };
    case "qa.upvote":
      return { type: "qa.upvote", playerId: await playerId(connectionId), questionId: msg.questionId };
    case "match.set":
      return { type: "match.set", playerId: await playerId(connectionId), interests: msg.interests };
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
    case "host.snapshot":
      return null;
    default:
      return null;
  }
}

async function playerId(connectionId: string): Promise<string> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const got = await doc.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: { pk: `CONN#${connectionId}`, sk: "META" } }));
  return String(got.Item?.playerId ?? "");
}

async function mutate(roomCode: string, command: Command, connectionId: string, clientTs?: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadRoom(roomCode);
    if (!current) return;
    const working = structuredClone(current);
    const result = apply(working, command, Date.now(), env);
    if (!result.ok) {
      if (result.error) await post(connectionId, { type: "error", ...result.error, serverTs: Date.now() });
      return;
    }
    const changed = result.phaseChanged || result.modeChanged || result.dirty.length > 0 || result.joined || result.answer || result.clientMsgId || result.kicked;
    if (!changed) return;
    const saved = await commitRoom(current, working, touchedPlayers(current, working));
    if (!saved) continue;
    await deliver(roomCode, working, result, connectionId, clientTs);
    if (result.scheduleAt) await schedule(roomCode, working.battle.generation, result.scheduleAt);
    if (result.dirty.some((k) => k === "board" || k === "cursors" || k === "standings")) await maybeFlush(roomCode, result);
    return;
  }
}

function touchedPlayers(prev: RoomState, next: RoomState): string[] {
  const ids = new Set([...Object.keys(prev.players), ...Object.keys(next.players)]);
  return [...ids].filter((id) => JSON.stringify(prev.players[id]) !== JSON.stringify(next.players[id]));
}

async function deliver(roomCode: string, state: RoomState, result: ApplyResult, connectionId: string, clientTs?: number): Promise<void> {
  const now = Date.now();
  if (result.joined) {
    const player = state.players[result.joined.playerId];
    const secrets = await loadSecrets();
    const exp = now + config.sessionTtlHours * 3_600_000;
    const token = issueToken({ r: "p", exp, room: roomCode, pid: player.id, did: player.deviceId }, secrets.signing);
    await putConnection(roomCode, connectionId, { role: "player", playerId: player.id, deviceId: player.deviceId });
    await post(connectionId, { type: "welcome", token, playerId: player.id, roomCode, state: playerView(state, env, player.id, now, features), serverTs: now, clientTs });
  }
  if (result.answer) await post(connectionId, { type: "answer.ack", ack: result.answer, serverTs: now, clientTs });
  else if (result.clientMsgId) await post(connectionId, { type: "ack", clientMsgId: result.clientMsgId, serverTs: now, clientTs });
  if (result.kicked) {
    const conns = await listConnections(roomCode);
    await postMany(
      conns.filter((c) => c.playerId === result.kicked?.playerId).map((c) => c.id),
      { type: "kicked", message: result.kicked.message, serverTs: now },
    );
  }
  if (result.phaseChanged) {
    await roomFanout(roomCode, {
      type: "battle",
      battle: battleView(state, env),
      standings: standingsView(state, config),
      screenMode: state.screenMode,
      serverTs: now,
    }, () => true);
  }
  if (result.modeChanged) {
    await roomFanout(roomCode, { type: "mode", screenMode: state.screenMode, serverTs: now }, () => true);
  }
}

async function maybeFlush(roomCode: string, result: ApplyResult): Promise<void> {
  const gap = Math.round(1000 / config.board.broadcastHz);
  const got = await broadcastLock(roomCode, "fanout", gap);
  if (!got) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.TIMER_QUEUE_URL,
      DelaySeconds: 1,
      MessageBody: JSON.stringify({ kind: "flush", roomCode }),
    }));
    return;
  }
  await flush(roomCode);
  void result;
}

async function flush(roomCode: string): Promise<void> {
  const state = await loadRoom(roomCode);
  if (!state) return;
  const now = Date.now();
  await roomFanout(roomCode, { type: "board", board: boardView(state, config), serverTs: now }, (c) => c.role === "host" || c.role === "screen" || Boolean(c.views?.includes("board")));
  await roomFanout(roomCode, { type: "cursors", cursors: cursorsView(state, now), serverTs: now }, (c) => c.role === "host" || c.role === "screen" || Boolean(c.views?.includes("board")));
  await roomFanout(roomCode, { type: "standings", standings: standingsView(state, config), serverTs: now }, (c) => c.role === "host" || c.role === "screen");
  await roomFanout(roomCode, { type: "lobby", lobby: lobbyView(state, config), serverTs: now }, (c) => c.role === "host" || c.role === "screen");
  await roomFanout(roomCode, { type: "qa", items: qaView(state, null, false), serverTs: now }, (c) => c.role !== "host");
  await roomFanout(roomCode, { type: "admin", admin: adminView(state, env, now, features), serverTs: now }, (c) => c.role === "host");
  await roomFanout(roomCode, { type: "match", yours: null, groups: groupsView(state, null), serverTs: now }, (c) => c.role === "host" || c.role === "screen");
}

async function schedule(roomCode: string, generation: number, at: number): Promise<void> {
  const delay = Math.min(900, Math.max(0, Math.ceil((at - Date.now()) / 1000)));
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.TIMER_QUEUE_URL,
    DelaySeconds: delay,
    MessageBody: JSON.stringify({ kind: "tick", roomCode, generation }),
  }));
}

function newCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}
