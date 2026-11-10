// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { writeSync } from "node:fs";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.js";
import { startLocalServer } from "../src/server/local.js";

interface Sample {
  join: number[];
  answer: number[];
  board: number[];
  errors: number;
  ops: number;
  mismatches: number;
  clients: number;
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function rnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Bot {
  ws: WebSocket | null = null;
  private queue: ServerMessage[] = [];
  private waiters: { type: string; resolve: (msg: ServerMessage) => void }[] = [];
  token = "";
  score = 0;
  teamId = "";

  name = "";

  constructor(private url: string, readonly deviceId: string) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("message", (data) => this.ingest(JSON.parse(data.toString()) as ServerMessage));
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private ingest(msg: ServerMessage): void {
    const idx = this.waiters.findIndex((w) => w.type === msg.type);
    if (idx >= 0) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  wait(type: string, timeoutMs = 8000): Promise<ServerMessage> {
    const idx = this.queue.findIndex((m) => m.type === type);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }
}

async function scenario(clients: number): Promise<Sample> {
  const sample: Sample = { join: [], answer: [], board: [], errors: 0, ops: 0, mismatches: 0, clients };
  const watchdog = setTimeout(() => {
    writeSync(2, `watchdog stuck in ${phase}\n`);
    process.exit(1);
  }, 20000);
  mark(`listen-${clients}`);
  const server = await startLocalServer({ port: 0, adminSecret: "local-dev-pin" });
  const random = rnd(20261128 + clients);
  try {
    mark(`host-${clients}`);
    const host = new Bot(server.wsUrl, "host");
    await host.open();
    host.send({ type: "host.login", secret: "local-dev-pin", clientTs: Date.now() });
    const welcome = await host.wait("host.welcome");
    if (welcome.type !== "host.welcome") throw new Error("host login failed");
    host.send({ type: "host.createRoom", token: welcome.token, clientTs: Date.now() });
    const created = await host.wait("room.created");
    if (created.type !== "room.created") throw new Error("room was not created");
    const code = created.roomCode;

    mark(`join-${clients}`);
    const bots: Bot[] = [];
    for (let start = 0; start < clients; start += 40) {
      const chunk = Math.min(40, clients - start);
      await Promise.all(Array.from({ length: chunk }, async (_, offset) => {
        const i = start + offset;
        const bot = new Bot(server.wsUrl, `dev-${clients}-${i}`);
        bot.name = `Builder ${i + 1}`;
        await bot.open();
        const clientTs = Date.now();
        sample.ops += 1;
        bot.send({ type: "join", roomCode: code, displayName: bot.name, deviceId: bot.deviceId, clientTs });
        const msg = await bot.wait("welcome");
        if (msg.type !== "welcome") {
          sample.errors += 1;
          return;
        }
        sample.join.push(Date.now() - (msg.clientTs ?? clientTs));
        bot.token = msg.token;
        bot.score = msg.state.you.score;
        bot.teamId = msg.state.you.teamId;
        bot.send({ type: "subscribe", views: ["board", "battle"], clientTs: Date.now() });
        bots.push(bot);
      }));
    }

    mark(`start-${clients}`);
    host.send({ type: "host.start", token: welcome.token, clientTs: Date.now() });
    const battle = await bots[0].wait("battle");
    if (battle.type !== "battle" || !battle.battle.question) throw new Error("question did not start");
    const questionId = battle.battle.question.id;

    mark(`answer-${clients}`);
    await Promise.all(bots.map(async (bot, i) => {
      if (random() < 0.15) {
        const before = bot.score;
        bot.close();
        await bot.open();
        bot.send({ type: "resume", token: bot.token, deviceId: bot.deviceId, clientTs: Date.now() });
        const restored = await bot.wait("welcome");
        if (restored.type !== "welcome" || restored.state.you.score !== before || restored.state.you.teamId !== bot.teamId) {
          sample.mismatches += 1;
        }
        bot.send({ type: "subscribe", views: ["board", "battle"], clientTs: Date.now() });
      }
      const clientTs = Date.now();
      const choice = i % 7 === 0 ? "b" : "a";
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: choice, clientMsgId: `a-${i}`, clientTs });
      const ack = await bot.wait("answer.ack");
      if (ack.type !== "answer.ack") {
        sample.errors += 1;
        return;
      }
      sample.answer.push(Date.now() - (ack.clientTs ?? clientTs));
      if (!ack.ack.duplicate) bot.score = ack.ack.totalScore;
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: "c", clientMsgId: `dup-${i}`, clientTs: Date.now() });
      const dup = await bot.wait("answer.ack");
      if (dup.type !== "answer.ack" || !dup.ack.duplicate || dup.ack.totalScore !== bot.score) sample.mismatches += 1;
    }));

    mark(`drop-${clients}`);
    const dropped = bots.filter(() => random() < 0.2);
    await Promise.all(dropped.map(async (bot) => {
      const before = bot.score;
      const team = bot.teamId;
      bot.close();
      await bot.open();
      bot.send({ type: "resume", token: bot.token, deviceId: bot.deviceId, clientTs: Date.now() });
      const restored = await bot.wait("welcome");
      if (restored.type !== "welcome" || restored.state.you.score !== before || restored.state.you.teamId !== team) {
        sample.mismatches += 1;
      } else {
        bot.score = restored.state.you.score;
      }
    }));

    mark(`board-${clients}`);
    await Promise.all(bots.map(async (bot, i) => {
      if (i < 20) {
        sample.ops += 1;
        const clientTs = Date.now();
        bot.send({
          type: "board.place",
          tileType: "lambda",
          x: (i * 4) % 90,
          y: 20,
          clientMsgId: `place-${i}`,
          clientTs,
        });
        const placed = await bot.wait("ack");
        if (placed.type === "ack") sample.board.push(Date.now() - (placed.clientTs ?? clientTs));
        else sample.errors += 1;
      }
      for (let n = 0; n < 5; n += 1) {
        const clientTs = Date.now();
        sample.ops += 1;
        bot.send({
          type: "board.cursor",
          x: (i + n * 3) % 100,
          y: (n * 11) % 100,
          clientMsgId: `c-${i}-${n}`,
          clientTs,
        });
        const ack = await bot.wait("ack");
        if (ack.type === "ack") sample.board.push(Date.now() - (ack.clientTs ?? clientTs));
        else sample.errors += 1;
      }
    }));

    mark(`check-${clients}`);
    const snapTs = Date.now();
    host.send({ type: "host.snapshot", token: welcome.token, clientTs: snapTs });
    let snap: ServerMessage | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const msg = await host.wait("admin");
      if (msg.type === "admin" && msg.clientTs === snapTs) {
        snap = msg;
        break;
      }
    }
    if (snap && snap.type === "admin") {
      const byId = new Map(snap.admin.players.map((p) => [p.name, p.score]));
      for (const bot of bots) {
        if (byId.get(bot.name) !== bot.score) sample.mismatches += 1;
      }
    } else {
      sample.errors += 1;
    }
    host.close();
    for (const bot of bots) bot.close();
  } finally {
    clearTimeout(watchdog);
    await server.close();
  }
  return sample;
}

function report(sample: Sample): void {
  const line = (name: string, values: number[]) =>
    `${name.padEnd(8)} n=${String(values.length).padStart(5)}  p50=${pct(values, 50).toFixed(1).padStart(7)}ms  p95=${pct(values, 95).toFixed(1).padStart(7)}ms`;
  console.log(`\nClients ${sample.clients}`);
  console.log(line("join", sample.join));
  console.log(line("answer", sample.answer));
  console.log(line("board", sample.board));
  console.log(`errors ${sample.errors} / ops ${sample.ops}    score mismatches ${sample.mismatches}`);
}

let phase = "boot";
const mark = (next: string) => {
  phase = next;
  writeSync(2, `phase ${next}\n`);
};

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const runs = sizes.length ? sizes : [50, 200];
const results = [];
for (const n of runs) {
  const sample = await scenario(n);
  report(sample);
  const errorRate = sample.ops ? sample.errors / sample.ops : 1;
  const answerP95 = pct(sample.answer, 95);
  const joinP95 = pct(sample.join, 95);
  const boardP95 = pct(sample.board, 95);
  results.push({
    clients: n,
    joinP50: pct(sample.join, 50),
    joinP95: joinP95,
    answerP50: pct(sample.answer, 50),
    answerP95: answerP95,
    boardP50: pct(sample.board, 50),
    boardP95: boardP95,
    errors: sample.errors,
    ops: sample.ops,
    mismatches: sample.mismatches,
  });
  if (sample.mismatches > 0 || errorRate > 0.01 || answerP95 > 500 || joinP95 > 500 || boardP95 > 500) {
    console.error("load test failed");
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }
}
console.log("\nLOAD_TEST_JSON");
console.log(JSON.stringify(results, null, 2));
