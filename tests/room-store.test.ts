// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import assert from "node:assert/strict";
import test from "node:test";
import { createRoom, type Command, type EngineEnv } from "../src/shared/engine.js";
import { loadConfig } from "../src/shared/event-config.js";
import { loadQuestions } from "../src/shared/questions.js";
import type { EventConfig } from "../src/shared/types.js";
import { MemoryBackend } from "../src/server/memory-backend.js";
import { RoomStore } from "../src/server/room-store.js";

const base = loadConfig();
const questions = loadQuestions();
const CODE = "ROOM42";

function envWith(caps: { roomCap?: number; maxNodes?: number; maxEdges?: number } = {}): EngineEnv {
  const config: EventConfig = {
    ...base,
    roomCap: caps.roomCap ?? base.roomCap,
    board: {
      ...base.board,
      maxNodes: caps.maxNodes ?? base.board.maxNodes,
      maxEdges: caps.maxEdges ?? base.board.maxEdges,
    },
  };
  return { config, questions };
}

async function newRoom(env: EngineEnv, backend = new MemoryBackend(), deadlineMs?: number): Promise<RoomStore> {
  const store = new RoomStore(backend, { deadlineMs });
  await store.createRoom(createRoom(CODE, Date.now()), env.config);
  return store;
}

function joinCmd(i: number): Command {
  return { type: "join", name: `Builder ${i}`, deviceId: `device-${i}` };
}

async function joinAll(store: RoomStore, env: EngineEnv, count: number) {
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(await store.applyCommand(CODE, joinCmd(i), Date.now(), env));
  return results;
}

async function counters(backend: MemoryBackend) {
  const row = await backend.get(`ROOM#${CODE}`, "COUNTERS");
  return row as { joined: number; nodes: number; edges: number };
}

function placeCmd(playerId: string, i: number): Command {
  return {
    type: "board.place",
    playerId,
    tileType: "lambda",
    x: (i * 7) % 100,
    y: (i * 13) % 100,
    clientMsgId: `place-${i}`,
  };
}

test("concurrent joins under the cap all succeed with distinct player ids", async () => {
  const env = envWith({ roomCap: 10 });
  const store = await newRoom(env);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.applyCommand(CODE, joinCmd(i), Date.now(), env)));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.map((r) => r.error)));
  const ids = results.map((r) => r.joined?.playerId ?? "");
  assert.equal(new Set(ids).size, 6);
  for (const id of ids) assert.match(id, /^p[0-9a-f-]{36}$/);
  const room = await store.loadRoom(CODE);
  assert.equal(Object.keys(room?.players ?? {}).length, 6);
});

test("concurrent joins over the cap: exactly roomCap succeed, the rest get full", async () => {
  const env = envWith({ roomCap: 5 });
  const backend = new MemoryBackend();
  const store = await newRoom(env, backend);
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => store.applyCommand(CODE, joinCmd(i), Date.now(), env)));
  const okCount = results.filter((r) => r.ok).length;
  const fullCount = results.filter((r) => !r.ok && r.error?.code === "full").length;
  assert.equal(okCount, 5);
  assert.equal(fullCount, 4);
  assert.equal((await counters(backend)).joined, 5, "overflow ADDs are undone");
  const room = await store.loadRoom(CODE);
  assert.equal(Object.keys(room?.players ?? {}).length, 5);
});

test("a join after the room is full returns full and leaves the count at the cap", async () => {
  const env = envWith({ roomCap: 2 });
  const backend = new MemoryBackend();
  const store = await newRoom(env, backend);
  const [a, b] = await joinAll(store, env, 2);
  assert.ok(a.ok && b.ok);
  const late = await store.applyCommand(CODE, joinCmd(99), Date.now(), env);
  assert.equal(late.ok, false);
  assert.equal(late.error?.code, "full");
  assert.equal((await counters(backend)).joined, 2);
});

test("teams spread across members from TEAM# items, not COUNTERS", async () => {
  const env = envWith({ roomCap: 20 });
  const backend = new MemoryBackend();
  const store = await newRoom(env, backend);
  await joinAll(store, env, 8);
  const room = await store.loadRoom(CODE);
  const teamIds = new Set(Object.values(room?.players ?? {}).map((p) => p.teamId));
  assert.equal(teamIds.size, env.config.teams.length, "eight joins fill all eight teams once each");
  const counterRow = (await counters(backend)) as unknown as Record<string, unknown>;
  assert.equal("teams" in counterRow, false, "COUNTERS carries totals only");
});

test("concurrent board.place calls each create a unique node", async () => {
  const env = envWith({ roomCap: 20, maxNodes: 50 });
  const store = await newRoom(env);
  const joined = await joinAll(store, env, 12);
  const ids = joined.map((r) => r.joined?.playerId ?? "");
  const placed = await Promise.all(ids.map((id, i) => store.applyCommand(CODE, placeCmd(id, i), Date.now(), env)));
  assert.ok(placed.every((r) => r.ok), JSON.stringify(placed.map((r) => r.error)));
  const room = await store.loadRoom(CODE);
  const nodeIds = room?.board.nodes.map((n) => n.id) ?? [];
  assert.equal(nodeIds.length, 12);
  assert.equal(new Set(nodeIds).size, 12);
  for (const id of nodeIds) assert.match(id, /^n[0-9a-f-]{36}$/);
});

test("placing past maxNodes returns board_full and stops the count", async () => {
  const env = envWith({ roomCap: 20, maxNodes: 3 });
  const backend = new MemoryBackend();
  const store = await newRoom(env, backend);
  const ids = (await joinAll(store, env, 6)).map((r) => r.joined?.playerId ?? "");
  const placed = await Promise.all(ids.map((id, i) => store.applyCommand(CODE, placeCmd(id, i), Date.now(), env)));
  assert.equal(placed.filter((r) => r.ok).length, 3);
  const full = placed.filter((r) => !r.ok);
  assert.equal(full.length, 3);
  assert.ok(full.every((r) => r.error?.code === "board_full" && r.error.clientMsgId?.startsWith("place-")));
  assert.equal((await counters(backend)).nodes, 3);
  const room = await store.loadRoom(CODE);
  assert.equal(room?.board.nodes.length, 3);
});

test("connecting past maxEdges returns board_full", async () => {
  const env = envWith({ roomCap: 20, maxNodes: 10, maxEdges: 1 });
  const store = await newRoom(env);
  const ids = (await joinAll(store, env, 4)).map((r) => r.joined?.playerId ?? "");
  const placed = [];
  for (let i = 0; i < 4; i += 1) placed.push(await store.applyCommand(CODE, placeCmd(ids[i], i), Date.now(), env));
  const nodeIds = (await store.loadRoom(CODE))?.board.nodes.map((n) => n.id) ?? [];
  const first = await store.applyCommand(CODE, { type: "board.connect", playerId: ids[0], from: nodeIds[0], to: nodeIds[1], clientMsgId: "e1" }, Date.now(), env);
  const second = await store.applyCommand(CODE, { type: "board.connect", playerId: ids[0], from: nodeIds[2], to: nodeIds[3], clientMsgId: "e2" }, Date.now(), env);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, "board_full");
  const duplicate = await store.applyCommand(CODE, { type: "board.connect", playerId: ids[0], from: nodeIds[1], to: nodeIds[0], clientMsgId: "e3" }, Date.now(), env);
  assert.equal(duplicate.error?.code, "board_full", "the cap is checked first, as before");
});

test("host.board.clear resets board totals and keeps the joined count", async () => {
  const env = envWith({ roomCap: 20, maxNodes: 2 });
  const backend = new MemoryBackend();
  const store = await newRoom(env, backend);
  const ids = (await joinAll(store, env, 3)).map((r) => r.joined?.playerId ?? "");
  for (let i = 0; i < 2; i += 1) assert.ok((await store.applyCommand(CODE, placeCmd(ids[i], i), Date.now(), env)).ok);
  assert.equal((await store.applyCommand(CODE, placeCmd(ids[2], 2), Date.now(), env)).error?.code, "board_full");

  const cleared = await store.applyCommand(CODE, { type: "host.board.clear" }, Date.now(), env);
  assert.equal(cleared.ok, true);
  const after = await counters(backend);
  assert.equal(after.nodes, 0);
  assert.equal(after.edges, 0);
  assert.equal(after.joined, 3);
  assert.ok((await store.applyCommand(CODE, placeCmd(ids[2], 2), Date.now(), env)).ok);
});

test("a NODE# conditional put does not overwrite an existing item", async () => {
  const backend = new MemoryBackend();
  const key = { pk: `ROOM#${CODE}`, sk: "NODE#nfixed" };
  const first = await backend.put({ ...key, node: { id: "nfixed", tileType: "lambda", x: 1, y: 1, by: "a", byName: "A" } }, "attribute_not_exists(pk)");
  const second = await backend.put({ ...key, node: { id: "nfixed", tileType: "s3", x: 9, y: 9, by: "b", byName: "B" } }, "attribute_not_exists(pk)");
  assert.equal(first, "ok");
  assert.equal(second, "conflict");
  const row = await backend.get(key.pk, key.sk);
  assert.equal((row?.node as { by: string }).by, "a");
});

test("ADD on COUNTERS creates the item, increments, and returns the new value", async () => {
  const backend = new MemoryBackend();
  const pk = `ROOM#${CODE}`;
  const up = await backend.update(pk, "COUNTERS", "ADD #f :one", { ":one": 1 }, { "#f": "joined" });
  assert.equal(up.status, "ok");
  assert.equal(up.attrs.joined, 1);
  const again = await backend.update(pk, "COUNTERS", "ADD #f :one", { ":one": 1 }, { "#f": "joined" });
  assert.equal(again.attrs.joined, 2);
  const down = await backend.update(pk, "COUNTERS", "ADD #f :neg", { ":neg": -1 }, { "#f": "joined" });
  assert.equal(down.attrs.joined, 1);
  const cond = await backend.update(pk, "COUNTERS", "ADD #f :one", { ":one": 1, ":max": 0 }, { "#f": "joined" }, "joined < :max");
  assert.equal(cond.status, "conflict");
});

test("a command that passes the deadline returns busy with its clientMsgId", async () => {
  const env = envWith({ roomCap: 20 });

  class SlowBackend extends MemoryBackend {
    delayMs = 0;
    override async get(pk: string, sk: string) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      return super.get(pk, sk);
    }
  }
  const backend = new SlowBackend();
  const store = await newRoom(env, backend, 50);
  const [joined] = await joinAll(store, env, 1);
  const playerId = joined.joined?.playerId ?? "";

  backend.delayMs = 150;
  const started = Date.now();
  const result = await store.applyCommand(CODE, placeCmd(playerId, 0), Date.now(), env);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "busy");
  assert.equal(result.error?.clientMsgId, "place-0");
  assert.ok(elapsed < 140, `returned after ${elapsed} ms, before the slow backend finished`);

  // Let the slow write finish so the test process does not leave work behind.
  backend.delayMs = 0;
  await new Promise((r) => setTimeout(r, 200));
});
