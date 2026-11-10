// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { Player, RoomState } from "../shared/types.js";

const table = process.env.TABLE_NAME ?? "";
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export function ttlSeconds(hours = Number(process.env.DATA_TTL_HOURS ?? 24)): number {
  return Math.floor(Date.now() / 1000) + hours * 3600;
}

export async function loadRoom(code: string): Promise<RoomState | null> {
  const meta = await doc.send(new GetCommand({ TableName: table, Key: { pk: `ROOM#${code}`, sk: "META" } }));
  if (!meta.Item?.state) return null;
  const state = meta.Item.state as RoomState;
  const players = await doc.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: { ":pk": `ROOM#${code}`, ":sk": "PLAYER#" },
  }));
  state.players = {};
  for (const item of players.Items ?? []) {
    const player = item.player as Player;
    if (player?.id) state.players[player.id] = player;
  }
  state.board.cursors = state.board.cursors ?? {};
  return state;
}

export async function createRoomItem(state: RoomState): Promise<void> {
  const { players, ...rest } = state;
  await doc.send(new PutCommand({
    TableName: table,
    Item: { pk: `ROOM#${state.code}`, sk: "META", version: state.version, state: { ...rest, players: {} }, ttl: ttlSeconds() },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  void players;
}

export async function commitRoom(previous: RoomState, next: RoomState, playerIds: string[]): Promise<boolean> {
  const { players, ...rest } = next;
  try {
    await doc.send(new PutCommand({
      TableName: table,
      Item: { pk: `ROOM#${next.code}`, sk: "META", version: next.version, state: { ...rest, players: {} }, ttl: ttlSeconds() },
      ConditionExpression: "version = :v",
      ExpressionAttributeValues: { ":v": previous.version },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
  for (const id of playerIds) {
    const player = players[id];
    if (!player) continue;
    await doc.send(new PutCommand({
      TableName: table,
      Item: { pk: `ROOM#${next.code}`, sk: `PLAYER#${id}`, player, ttl: ttlSeconds() },
    }));
  }
  return true;
}

export async function putConnection(roomCode: string, connectionId: string, fields: Record<string, unknown>): Promise<void> {
  const ttl = ttlSeconds();
  await doc.send(new PutCommand({
    TableName: table,
    Item: { pk: `ROOM#${roomCode}`, sk: `CONN#${connectionId}`, ...fields, ttl },
  }));
  await doc.send(new PutCommand({
    TableName: table,
    Item: { pk: `CONN#${connectionId}`, sk: "META", roomCode, ...fields, ttl },
  }));
}

export async function deleteConnection(connectionId: string): Promise<{ roomCode?: string; playerId?: string; role?: string }> {
  const got = await doc.send(new GetCommand({ TableName: table, Key: { pk: `CONN#${connectionId}`, sk: "META" } }));
  const roomCode = got.Item?.roomCode as string | undefined;
  const playerId = got.Item?.playerId as string | undefined;
  const role = got.Item?.role as string | undefined;
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: `CONN#${connectionId}`, sk: "META" } }));
  if (roomCode) await doc.send(new DeleteCommand({ TableName: table, Key: { pk: `ROOM#${roomCode}`, sk: `CONN#${connectionId}` } }));
  return { roomCode, playerId, role };
}

export async function listConnections(roomCode: string): Promise<{ id: string; role?: string; playerId?: string; views?: string[] }[]> {
  const out = await doc.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: { ":pk": `ROOM#${roomCode}`, ":sk": "CONN#" },
  }));
  return (out.Items ?? []).map((item) => ({
    id: String(item.sk).slice("CONN#".length),
    role: item.role as string | undefined,
    playerId: item.playerId as string | undefined,
    views: item.views as string[] | undefined,
  }));
}

export async function loginAllowed(ip: string, now: number, maxFails: number, windowMs: number): Promise<boolean> {
  const got = await doc.send(new GetCommand({ TableName: table, Key: { pk: "LOGIN", sk: ip } }));
  const lockUntil = Number(got.Item?.lockUntil ?? 0);
  const windowStart = Number(got.Item?.windowStart ?? 0);
  if (lockUntil > now) return false;
  if (now - windowStart > windowMs) return true;
  return Number(got.Item?.fails ?? 0) < maxFails;
}

export async function loginFail(ip: string, now: number, maxFails: number, windowMs: number, lockMs: number): Promise<void> {
  const got = await doc.send(new GetCommand({ TableName: table, Key: { pk: "LOGIN", sk: ip } }));
  let fails = Number(got.Item?.fails ?? 0);
  let windowStart = Number(got.Item?.windowStart ?? now);
  if (now - windowStart > windowMs) {
    fails = 0;
    windowStart = now;
  }
  fails += 1;
  const lockUntil = fails >= maxFails ? now + lockMs : 0;
  await doc.send(new PutCommand({
    TableName: table,
    Item: { pk: "LOGIN", sk: ip, fails, windowStart, lockUntil, ttl: ttlSeconds(1) },
  }));
}

export async function loginSuccess(ip: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: "LOGIN", sk: ip } }));
}

export async function broadcastLock(roomCode: string, kind: string, gapMs: number): Promise<boolean> {
  const now = Date.now();
  try {
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: { pk: `ROOM#${roomCode}`, sk: `LOCK#${kind}` },
      UpdateExpression: "SET until = :until, #ttl = :ttl",
      ConditionExpression: "attribute_not_exists(until) OR until < :now",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":until": now + gapMs, ":now": now, ":ttl": ttlSeconds() },
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
