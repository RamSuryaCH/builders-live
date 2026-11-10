import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.js";
import { startLocalServer } from "../src/server/local.js";

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, type: string, timeoutMs = 3000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

test("local socket: join, answer once, drop, resume with the same score", async () => {
  const server = await startLocalServer({ port: 0, adminSecret: "local-dev-pin" });
  try {
    const host = await connect(server.wsUrl);
    host.send(JSON.stringify({ type: "host.login", secret: "local-dev-pin", clientTs: Date.now() } satisfies ClientMessage));
    const welcome = await waitFor(host, "host.welcome");
    assert.equal(welcome.type, "host.welcome");
    host.send(JSON.stringify({ type: "host.createRoom", token: welcome.token, clientTs: Date.now() } satisfies ClientMessage));
    const created = await waitFor(host, "room.created");
    assert.equal(created.type, "room.created");
    assert.match(created.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);

    const phone = await connect(server.wsUrl);
    const sentAt = Date.now();
    phone.send(JSON.stringify({
      type: "join",
      roomCode: created.roomCode,
      displayName: "Mina",
      deviceId: "phone-1",
      clientTs: sentAt,
    } satisfies ClientMessage));
    const joined = await waitFor(phone, "welcome");
    assert.equal(joined.type, "welcome");
    assert.equal(joined.state.you.name, "Mina");
    assert.ok(joined.state.you.teamName.length > 0);

    host.send(JSON.stringify({ type: "host.start", token: welcome.token, clientTs: Date.now() } satisfies ClientMessage));
    const battle = await waitFor(phone, "battle");
    assert.equal(battle.type, "battle");
    assert.equal(battle.screenMode, "battle");
    assert.equal(battle.battle.phase, "question");
    const questionId = battle.battle.question?.id;
    assert.ok(questionId);

    phone.send(JSON.stringify({
      type: "answer",
      questionId,
      choiceId: "a",
      clientMsgId: "once",
      clientTs: Date.now(),
    } satisfies ClientMessage));
    const ack = await waitFor(phone, "answer.ack");
    assert.equal(ack.type, "answer.ack");
    const score = ack.ack.totalScore;
    phone.send(JSON.stringify({
      type: "answer",
      questionId,
      choiceId: "b",
      clientMsgId: "twice",
      clientTs: Date.now(),
    } satisfies ClientMessage));
    const dup = await waitFor(phone, "answer.ack");
    assert.equal(dup.type, "answer.ack");
    assert.equal(dup.ack.duplicate, true);
    assert.equal(dup.ack.totalScore, score);

    phone.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await connect(server.wsUrl);
    again.send(JSON.stringify({
      type: "resume",
      token: joined.token,
      deviceId: "phone-1",
      clientTs: Date.now(),
    } satisfies ClientMessage));
    const restored = await waitFor(again, "welcome");
    assert.equal(restored.type, "welcome");
    assert.equal(restored.state.you.score, score);
    assert.equal(restored.state.you.teamId, joined.state.you.teamId);
    again.close();
    host.close();
  } finally {
    await server.close();
  }
});
