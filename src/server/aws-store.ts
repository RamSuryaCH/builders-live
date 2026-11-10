// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { DynamoBackend } from "./dynamo-backend.js";
import { RoomStore } from "./room-store.js";
import type { RoomState } from "../shared/types.js";
import type { EventConfig } from "../shared/types.js";

const store = new RoomStore(new DynamoBackend());

export function getStore(): RoomStore {
  return store;
}

export async function createRoomItem(state: RoomState, config?: EventConfig): Promise<void> {
  await store.createRoom(state, config);
}

export async function loadRoom(code: string): Promise<RoomState | null> {
  return store.loadRoom(code);
}

export async function putConnection(roomCode: string, connectionId: string, fields: Record<string, unknown>): Promise<void> {
  return store.putConnection(roomCode, connectionId, fields);
}

export async function deleteConnection(connectionId: string) {
  return store.deleteConnection(connectionId);
}

export async function listConnections(roomCode: string) {
  return store.listConnections(roomCode);
}

export async function loginAllowed(ip: string, now: number, maxFails: number, windowMs: number) {
  return store.loginAllowed(ip, now, maxFails, windowMs);
}

export async function loginFail(ip: string, now: number, maxFails: number, windowMs: number, lockMs: number) {
  return store.loginFail(ip, now, maxFails, windowMs, lockMs);
}

export async function loginSuccess(ip: string) {
  return store.loginSuccess(ip);
}

export async function broadcastLock(roomCode: string, kind: string, gapMs: number) {
  return store.broadcastLock(roomCode, kind, gapMs);
}
