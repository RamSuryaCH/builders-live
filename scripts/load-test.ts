// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { writeSync } from "node:fs";
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol.js";
import { startLocalServer, type RunningServer } from "../src/server/local.js";
import { loadConfig } from "../src/shared/event-config.js";

interface GameStats {
  questionsPlayed: number;
  questionsPlanned: number;
  roundsCompleted: number;
  roundsTotal: number;
  finished: boolean;
}

interface Sample {
  join: number[];
  answer: number[];
  board: number[];
  errors: number;
  ops: number;
  mismatches: number;
  clients: number;
  game?: GameStats;
}

const FULL_GAME = process.env.FULL_GAME === "1";

/** Duration of a full game, from the event config: question and reveal windows, intros, and round breaks, plus 60 s. */
function expectedGameMs(): number {
  const config = loadConfig();
  const b = config.battle;
  const planned = config.roundPlan.reduce((sum, spec) => sum + (spec.count ?? b.questionsPerRound), 0);
  const intros = config.roundPlan.filter((spec) => spec.intro).length;
  const seconds =
    planned * (b.questionSeconds + b.revealSeconds) + intros * b.introSeconds + (b.rounds - 1) * b.roundBreakSeconds;
  return seconds * 1000 + 60000;
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

  /** Optional tap on every inbound message, used by the full-game mode. */
  onMessage: ((msg: ServerMessage) => void) | null = null;

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
    this.onMessage?.(msg);
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

interface Target {
  wsUrl: string;
  hostPin: string;
  remote: boolean;
  server: RunningServer | null;
  waitMs: number;
}

async function resolveTarget(): Promise<Target> {
  const wsUrl = process.env.WS_URL?.trim();
  if (wsUrl) {
    const hostPin = process.env.HOST_PIN?.trim();
    if (!hostPin) {
      throw new Error("HOST_PIN is required when WS_URL is set");
    }
    return { wsUrl, hostPin, remote: true, server: null, waitMs: 20000 };
  }
  const server = await startLocalServer({ port: 0, adminSecret: "local-dev-pin" });
  return { wsUrl: server.wsUrl, hostPin: "local-dev-pin", remote: false, server, waitMs: 8000 };
}

interface FullGameRun {
  finished: Promise<void>;
  stats: () => GameStats;
  detach: () => void;
}

/** Hooks every bot to answer each question it is shown, and the host to watch the battle phases. */
function attachFullGame(host: Bot, bots: Bot[], sample: Sample, random: () => number): FullGameRun {
  const config = loadConfig();
  const seen = new Set<string>();
  const rounds = new Set<number>();
  let finishedSeen = false;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  host.onMessage = (msg) => {
    if (msg.type !== "battle") return;
    const battle = msg.battle;
    if (battle.phase === "question" && battle.question) seen.add(battle.question.id);
    if (battle.phase === "break" || battle.phase === "finished") rounds.add(battle.round);
    if (battle.phase === "finished") {
      finishedSeen = true;
      resolveFinished();
    }
  };

  for (const bot of bots) {
    const answered = new Set<string>();
    bot.onMessage = (msg) => {
      if (msg.type === "answer.ack") {
        if (msg.clientTs != null) sample.answer.push(Date.now() - msg.clientTs);
        if (!msg.ack.duplicate) bot.score = msg.ack.totalScore;
      } else if (msg.type === "error") {
        sample.errors += 1;
      } else if (msg.type === "battle" && msg.battle.phase === "question" && msg.battle.question) {
        const question = msg.battle.question;
        if (answered.has(question.id)) return;
        answered.add(question.id);
        const choice = question.choices[Math.floor(random() * question.choices.length)];
        sample.ops += 1;
        bot.send({
          type: "answer",
          questionId: question.id,
          choiceId: choice.id,
          clientMsgId: `g-${question.id}-${bot.deviceId}`,
          clientTs: Date.now(),
        });
      }
    };
  }

  const planned = config.roundPlan.reduce((sum, spec) => sum + (spec.count ?? config.battle.questionsPerRound), 0);
  return {
    finished,
    stats: () => ({
      questionsPlayed: seen.size,
      questionsPlanned: planned,
      roundsCompleted: rounds.size,
      roundsTotal: config.battle.rounds,
      finished: finishedSeen,
    }),
    detach: () => {
      host.onMessage = null;
      for (const bot of bots) bot.onMessage = null;
    },
  };
}

async function scenario(clients: number, target: Target): Promise<Sample> {
  const sample: Sample = { join: [], answer: [], board: [], errors: 0, ops: 0, mismatches: 0, clients };
  const watchdog = setTimeout(() => {
    writeSync(2, `watchdog stuck in ${phase}\n`);
    process.exit(1);
  }, FULL_GAME ? expectedGameMs() + 120000 : target.remote ? 120000 : 45000);
  mark(`host-${clients}`);
  const random = rnd(20261128 + clients);
  const host = new Bot(target.wsUrl, "host");
  try {
    await host.open();
    host.send({ type: "host.login", secret: target.hostPin, clientTs: Date.now() });
    const welcome = await host.wait("host.welcome", target.waitMs);
    if (welcome.type !== "host.welcome") throw new Error("host login failed");
    host.send({ type: "host.createRoom", token: welcome.token, clientTs: Date.now() });
    const created = await host.wait("room.created", target.waitMs);
    if (created.type !== "room.created") throw new Error("room was not created");
    const code = created.roomCode;

    mark(`join-${clients}`);
    const bots: Bot[] = [];
    for (let start = 0; start < clients; start += 40) {
      const chunk = Math.min(40, clients - start);
      await Promise.all(Array.from({ length: chunk }, async (_, offset) => {
        const i = start + offset;
        const bot = new Bot(target.wsUrl, `dev-${clients}-${i}`);
        bot.name = `Builder ${i + 1}`;
        try {
          await bot.open();
        } catch {
          sample.errors += 1;
          sample.ops += 1;
          return;
        }
        const clientTs = Date.now();
        sample.ops += 1;
        bot.send({ type: "join", roomCode: code, displayName: bot.name, deviceId: bot.deviceId, clientTs });
        let msg: ServerMessage;
        try {
          msg = await bot.wait("welcome", target.waitMs);
        } catch {
          sample.errors += 1;
          bot.close();
          return;
        }
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
    const run = FULL_GAME ? attachFullGame(host, bots, sample, random) : null;
    host.send({ type: "host.start", token: welcome.token, clientTs: Date.now() });
    const battle = await bots[0].wait("battle", target.waitMs);
    if (battle.type !== "battle" || !battle.battle.question) throw new Error("question did not start");
    const questionId = battle.battle.question.id;

    if (run) {
      mark(`game-${clients}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, expectedGameMs());
      });
      await Promise.race([run.finished, timeout]);
      clearTimeout(timer);
      run.detach();
      sample.game = run.stats();
      if (!sample.game.finished) sample.errors += 1;
    }

    mark(`answer-${clients}`);
    if (!FULL_GAME) await Promise.all(bots.map(async (bot, i) => {
      if (random() < 0.15) {
        const before = bot.score;
        bot.close();
        await bot.open();
        bot.send({ type: "resume", token: bot.token, deviceId: bot.deviceId, clientTs: Date.now() });
        const restored = await bot.wait("welcome", target.waitMs);
        if (restored.type !== "welcome" || restored.state.you.score !== before || restored.state.you.teamId !== bot.teamId) {
          sample.mismatches += 1;
        }
        bot.send({ type: "subscribe", views: ["board", "battle"], clientTs: Date.now() });
      }
      const clientTs = Date.now();
      const choice = i % 7 === 0 ? "b" : "a";
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: choice, clientMsgId: `a-${i}`, clientTs });
      const ack = await bot.wait("answer.ack", target.waitMs);
      if (ack.type !== "answer.ack") {
        sample.errors += 1;
        return;
      }
      sample.answer.push(Date.now() - (ack.clientTs ?? clientTs));
      if (!ack.ack.duplicate) bot.score = ack.ack.totalScore;
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: "c", clientMsgId: `dup-${i}`, clientTs: Date.now() });
      const dup = await bot.wait("answer.ack", target.waitMs);
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
      const restored = await bot.wait("welcome", target.waitMs);
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
        const placed = await bot.wait("ack", target.waitMs);
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
        const ack = await bot.wait("ack", target.waitMs);
        if (ack.type === "ack") sample.board.push(Date.now() - (ack.clientTs ?? clientTs));
        else sample.errors += 1;
      }
    }));

    mark(`check-${clients}`);
    const snapTs = Date.now();
    host.send({ type: "host.snapshot", token: welcome.token, clientTs: snapTs });
    let snap: ServerMessage | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const msg = await host.wait("admin", target.waitMs);
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
  if (sample.game) {
    const g = sample.game;
    console.log(
      `game     questions ${g.questionsPlayed}/${g.questionsPlanned}  rounds ${g.roundsCompleted}/${g.roundsTotal}  finished ${g.finished ? "yes" : "no"}`,
    );
  }
}

let phase = "boot";
const mark = (next: string) => {
  phase = next;
  writeSync(2, `phase ${next}\n`);
};

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const runs = sizes.length ? sizes : [50, 200];
const target = await resolveTarget();
if (target.remote) {
  console.log(`Remote load test against ${target.wsUrl}`);
}
const results = [];
try {
  for (const n of runs) {
    const sample = await scenario(n, target);
    report(sample);
    const errorRate = sample.ops ? sample.errors / sample.ops : 1;
    const answerP95 = pct(sample.answer, 95);
    const joinP95 = pct(sample.join, 95);
    const boardP95 = pct(sample.board, 95);
    results.push({
      clients: n,
      joinN: sample.join.length,
      joinP50: pct(sample.join, 50),
      joinP95: joinP95,
      answerP50: pct(sample.answer, 50),
      answerP95: answerP95,
      boardP50: pct(sample.board, 50),
      boardP95: boardP95,
      errors: sample.errors,
      ops: sample.ops,
      mismatches: sample.mismatches,
      game: sample.game ?? null,
    });
    const gameFailed = sample.game ? !sample.game.finished || sample.game.questionsPlayed < sample.game.questionsPlanned : false;
    if (sample.mismatches > 0 || errorRate > 0.01 || answerP95 > 500 || joinP95 > 500 || boardP95 > 500 || gameFailed) {
      console.error("load test failed");
      console.log(JSON.stringify(results, null, 2));
      process.exitCode = 1;
      break;
    }
  }
  if (!process.exitCode) {
    console.log("\nLOAD_TEST_JSON");
    console.log(JSON.stringify(results, null, 2));
  }
} finally {
  if (target.server) await target.server.close();
}
