// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { writeSync } from "node:fs";
import { WebSocket } from "ws";
import type { AdminView, ClientMessage, ServerMessage } from "../src/shared/protocol.js";
import { startLocalServer, type RunningServer } from "../src/server/local.js";
import { loadConfig } from "../src/shared/event-config.js";

interface GameStats {
  questionsPlayed: number;
  questionsPlanned: number;
  roundsCompleted: number;
  roundsTotal: number;
  finished: boolean;
}

/** Timed-out waits, counted per operation. */
interface Timeouts {
  boardPlaceTimeouts: number;
  boardCursorTimeouts: number;
  answerTimeouts: number;
  welcomeTimeouts: number;
  resumeTimeouts: number;
}

/**
 * What happened to each board.place that timed out. Each timed-out place is
 * checked against a host snapshot and the replies that arrived after its wait gave up.
 */
interface PlaceEvidence {
  timedOut: number;
  /** A node sits at the placed x/y with this bot's name. */
  nodeAppeared: number;
  /** No node, and the server replied with an error for this clientMsgId after the timeout. */
  serverError: number;
  /** No node and no error reply. */
  neither: number;
  /** The host snapshot was unavailable, so the node check did not run. */
  unchecked: number;
  /** Independent of the three categories above: the ack arrived after the timeout. */
  lateAck: number;
}

interface Sample {
  join: number[];
  answer: number[];
  board: number[];
  errors: number;
  ops: number;
  mismatches: number;
  clients: number;
  phases: "full" | "board";
  timeouts: Timeouts;
  errorCodes: Record<string, number>;
  boardPlaceEvidence: PlaceEvidence;
  /** Set when the scenario threw or the watchdog fired. */
  fatal?: string;
  game?: GameStats;
}

const FULL_GAME = process.env.FULL_GAME === "1";

const PHASES = process.env.PHASES?.trim() ?? "";
if (PHASES && PHASES !== "board") {
  throw new Error(`unknown PHASES "${PHASES}" (expected "board" or unset)`);
}
/** Board-only run: host login, room, joins, subscribe, and board ops. No game, answers, or resume. */
const BOARD_ONLY = PHASES === "board" || process.env.ONLY_BOARD === "1";
if (BOARD_ONLY && FULL_GAME) {
  throw new Error("PHASES=board (or ONLY_BOARD=1) cannot be combined with FULL_GAME=1");
}

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

function newSample(clients: number): Sample {
  return {
    join: [],
    answer: [],
    board: [],
    errors: 0,
    ops: 0,
    mismatches: 0,
    clients,
    phases: BOARD_ONLY ? "board" : "full",
    timeouts: {
      boardPlaceTimeouts: 0,
      boardCursorTimeouts: 0,
      answerTimeouts: 0,
      welcomeTimeouts: 0,
      resumeTimeouts: 0,
    },
    errorCodes: {},
    boardPlaceEvidence: { timedOut: 0, nodeAppeared: 0, serverError: 0, neither: 0, unchecked: 0, lateAck: 0 },
  };
}

/** Bots with an open socket. The watchdog closes these so a stuck run cannot keep the process alive. */
const openBots = new Set<Bot>();

/** The clientMsgId an ack or error answers. Answers keep it on the nested ack object. */
function replyId(msg: ServerMessage): string | undefined {
  if (msg.type === "ack" || msg.type === "error") return msg.clientMsgId;
  if (msg.type === "answer.ack") return msg.ack.clientMsgId;
  return undefined;
}

interface Waiter {
  types: string[];
  id?: string;
  resolve: (msg: ServerMessage) => void;
}

/**
 * A message satisfies a wait when its type is expected and, if the wait names a
 * clientMsgId, the message either carries that id or carries no id at all.
 * Replies for other operations therefore never resolve this wait.
 */
function satisfies(msg: ServerMessage, types: string[], id?: string): boolean {
  if (!types.includes(msg.type)) return false;
  if (id === undefined) return true;
  const got = replyId(msg);
  return got === undefined || got === id;
}

class Bot {
  ws: WebSocket | null = null;
  private queue: ServerMessage[] = [];
  private waiters: Waiter[] = [];
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
      openBots.add(this);
      ws.on("message", (data) => this.ingest(JSON.parse(data.toString()) as ServerMessage));
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    openBots.delete(this);
  }

  private ingest(msg: ServerMessage): void {
    this.onMessage?.(msg);
    const idx = this.waiters.findIndex((w) => satisfies(msg, w.types, w.id));
    if (idx >= 0) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Resolves with the first message of one of the given types, or rejects after
   * timeoutMs. On timeout the waiter is removed, so a reply that arrives later
   * is queued and does not resolve a later wait.
   */
  wait(types: string | string[], timeoutMs = 8000, id?: string): Promise<ServerMessage> {
    const list = typeof types === "string" ? [types] : types;
    const idx = this.queue.findIndex((m) => satisfies(m, list, id));
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        types: list,
        id,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timeout waiting for ${list.join("|")}${id ? ` (${id})` : ""}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** An ack or error for clientMsgId that arrived with no waiter attached, typically after its timeout. */
  lateReply(id: string): ServerMessage | undefined {
    return this.queue.find((m) => (m.type === "ack" || m.type === "error" || m.type === "answer.ack") && replyId(m) === id);
  }

  send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }
}

/** Result of one per-op wait. Timeouts and server errors are recorded on the sample. */
type Outcome<T extends ServerMessage["type"]> =
  | { status: "ok"; msg: Extract<ServerMessage, { type: T }> }
  | { status: "timeout" }
  | { status: "error"; code: string };

/**
 * Waits for the reply to one operation. The reply is the expected type, or an
 * error. A timeout counts as an error and a timeout for its op key. A server error counts
 * as an error and its code is recorded. Neither throws, so the scenario keeps going.
 * The caller must already have counted the op in sample.ops.
 */
async function awaitOp<T extends ServerMessage["type"]>(
  bot: Bot,
  sample: Sample,
  key: keyof Timeouts,
  type: T,
  timeoutMs: number,
  id?: string,
): Promise<Outcome<T>> {
  let msg: ServerMessage;
  try {
    msg = await bot.wait([type, "error"], timeoutMs, id);
  } catch {
    sample.errors += 1;
    sample.timeouts[key] += 1;
    return { status: "timeout" };
  }
  if (msg.type === "error") {
    sample.errors += 1;
    sample.errorCodes[msg.code] = (sample.errorCodes[msg.code] ?? 0) + 1;
    return { status: "error", code: msg.code };
  }
  return { status: "ok", msg: msg as Extract<ServerMessage, { type: T }> };
}

/** Fetches a host snapshot. Returns null if no matching admin view arrives in time. */
async function fetchSnapshot(host: Bot, token: string, waitMs: number): Promise<AdminView | null> {
  const clientTs = Date.now();
  host.send({ type: "host.snapshot", token, clientTs });
  try {
    // Queued admin pushes resolve immediately, so the cap only limits how many stale ones are skipped.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const msg = await host.wait("admin", waitMs);
      if (msg.type === "admin" && msg.clientTs === clientTs) return msg.admin;
    }
  } catch {
    // Reported by the caller as a missing snapshot.
  }
  return null;
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

function watchdogMs(target: Target): number {
  if (FULL_GAME) return expectedGameMs() + 120000;
  // Each bot does one place and five cursors, and each wait can take waitMs.
  const boardBudget = 6 * target.waitMs + 60000;
  return target.remote ? Math.max(180000, boardBudget) : 45000;
}

/**
 * Runs one scenario into `sample`. Throws on setup failures. A watchdog rejects
 * the run after watchdogMs and closes every socket, so the caller can still print the summary.
 */
async function scenario(clients: number, target: Target, sample: Sample): Promise<void> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error(`watchdog stuck in ${phase}`)), watchdogMs(target));
  });
  try {
    await Promise.race([body(clients, target, sample), stuck]);
  } finally {
    clearTimeout(watchdog);
    for (const bot of [...openBots]) bot.close();
  }
}

async function body(clients: number, target: Target, sample: Sample): Promise<void> {
  mark(`host-${clients}`);
  const random = rnd(20261128 + clients);
  const host = new Bot(target.wsUrl, "host");
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
      // Harness pacing, not a server fix: stagger each socket in the chunk by about
      // 20 ms so 40 handshakes are not opened in one instant. Real failures are still counted.
      await new Promise((r) => setTimeout(r, offset * 20 + Math.floor(random() * 20)));
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
      const joined = await awaitOp(bot, sample, "welcomeTimeouts", "welcome", target.waitMs);
      if (joined.status !== "ok") {
        bot.close();
        return;
      }
      const msg = joined.msg;
      sample.join.push(Date.now() - (msg.clientTs ?? clientTs));
      bot.token = msg.token;
      bot.score = msg.state.you.score;
      bot.teamId = msg.state.you.teamId;
      bot.send({ type: "subscribe", views: ["board", "battle"], clientTs: Date.now() });
      bots.push(bot);
    }));
  }

  if (!BOARD_ONLY) {
    mark(`start-${clients}`);
    const game = FULL_GAME ? attachFullGame(host, bots, sample, random) : null;
    host.send({ type: "host.start", token: welcome.token, clientTs: Date.now() });
    const battle = await bots[0].wait("battle", target.waitMs);
    if (battle.type !== "battle" || !battle.battle.question) throw new Error("question did not start");
    const questionId = battle.battle.question.id;

    if (game) {
      mark(`game-${clients}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, expectedGameMs());
      });
      await Promise.race([game.finished, timeout]);
      clearTimeout(timer);
      game.detach();
      sample.game = game.stats();
      if (!sample.game.finished) sample.errors += 1;
    }

    mark(`answer-${clients}`);
    if (!FULL_GAME) await Promise.all(bots.map(async (bot, i) => {
      if (random() < 0.15) {
        const before = bot.score;
        bot.close();
        await bot.open();
        bot.send({ type: "resume", token: bot.token, deviceId: bot.deviceId, clientTs: Date.now() });
        const restored = await awaitOp(bot, sample, "resumeTimeouts", "welcome", target.waitMs);
        if (restored.status === "ok" && (restored.msg.state.you.score !== before || restored.msg.state.you.teamId !== bot.teamId)) {
          sample.mismatches += 1;
        }
        bot.send({ type: "subscribe", views: ["board", "battle"], clientTs: Date.now() });
      }
      const clientTs = Date.now();
      const choice = i % 7 === 0 ? "b" : "a";
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: choice, clientMsgId: `a-${i}`, clientTs });
      const ack = await awaitOp(bot, sample, "answerTimeouts", "answer.ack", target.waitMs, `a-${i}`);
      if (ack.status !== "ok") return;
      sample.answer.push(Date.now() - (ack.msg.clientTs ?? clientTs));
      if (!ack.msg.ack.duplicate) bot.score = ack.msg.ack.totalScore;
      sample.ops += 1;
      bot.send({ type: "answer", questionId, choiceId: "c", clientMsgId: `dup-${i}`, clientTs: Date.now() });
      const dup = await awaitOp(bot, sample, "answerTimeouts", "answer.ack", target.waitMs, `dup-${i}`);
      if (dup.status === "ok" && (!dup.msg.ack.duplicate || dup.msg.ack.totalScore !== bot.score)) sample.mismatches += 1;
    }));

    mark(`drop-${clients}`);
    const dropped = bots.filter(() => random() < 0.2);
    await Promise.all(dropped.map(async (bot) => {
      const before = bot.score;
      const team = bot.teamId;
      bot.close();
      await bot.open();
      bot.send({ type: "resume", token: bot.token, deviceId: bot.deviceId, clientTs: Date.now() });
      const restored = await awaitOp(bot, sample, "resumeTimeouts", "welcome", target.waitMs);
      if (restored.status !== "ok") return;
      if (restored.msg.state.you.score !== before || restored.msg.state.you.teamId !== team) {
        sample.mismatches += 1;
      } else {
        bot.score = restored.msg.state.you.score;
      }
    }));
  }

  mark(`board-${clients}`);
  const misses: { bot: Bot; x: number; y: number; clientMsgId: string }[] = [];
  await Promise.all(bots.map(async (bot, i) => {
    if (i < 20) {
      const x = (i * 4) % 90;
      const y = 20;
      const clientMsgId = `place-${i}`;
      sample.ops += 1;
      const clientTs = Date.now();
      bot.send({ type: "board.place", tileType: "lambda", x, y, clientMsgId, clientTs });
      const placed = await awaitOp(bot, sample, "boardPlaceTimeouts", "ack", target.waitMs, clientMsgId);
      if (placed.status === "ok") sample.board.push(Date.now() - (placed.msg.clientTs ?? clientTs));
      else if (placed.status === "timeout") misses.push({ bot, x, y, clientMsgId });
    }
    for (let n = 0; n < 5; n += 1) {
      const clientTs = Date.now();
      const clientMsgId = `c-${i}-${n}`;
      sample.ops += 1;
      bot.send({
        type: "board.cursor",
        x: (i + n * 3) % 100,
        y: (n * 11) % 100,
        clientMsgId,
        clientTs,
      });
      const ack = await awaitOp(bot, sample, "boardCursorTimeouts", "ack", target.waitMs, clientMsgId);
      if (ack.status === "ok") sample.board.push(Date.now() - (ack.msg.clientTs ?? clientTs));
    }
  }));

  mark(`check-${clients}`);
  // The snapshot is the only source for the board-only evidence check. A full run checks scores too.
  if (!BOARD_ONLY || misses.length > 0) {
    const snap = await fetchSnapshot(host, welcome.token, target.waitMs);
    if (!snap) sample.errors += 1;
    for (const miss of misses) {
      const evidence = sample.boardPlaceEvidence;
      evidence.timedOut += 1;
      const late = miss.bot.lateReply(miss.clientMsgId);
      if (late?.type === "ack") evidence.lateAck += 1;
      if (!snap) {
        evidence.unchecked += 1;
      } else if (snap.board.nodes.some((node) => node.x === miss.x && node.y === miss.y && node.byName === miss.bot.name)) {
        evidence.nodeAppeared += 1;
      } else if (late?.type === "error") {
        evidence.serverError += 1;
      } else {
        evidence.neither += 1;
      }
    }
    if (snap && !BOARD_ONLY) {
      const byId = new Map(snap.players.map((p) => [p.name, p.score]));
      for (const bot of bots) {
        if (byId.get(bot.name) !== bot.score) sample.mismatches += 1;
      }
    }
  }
  host.close();
  for (const bot of bots) bot.close();
}

function failureReasons(sample: Sample): string[] {
  const reasons: string[] = [];
  const errorRate = sample.ops ? sample.errors / sample.ops : 1;
  if (sample.fatal) reasons.push(`run aborted: ${sample.fatal}`);
  if (sample.mismatches > 0) reasons.push(`${sample.mismatches} score mismatches`);
  if (errorRate > 0.01) reasons.push(`error rate ${(errorRate * 100).toFixed(2)}%`);
  if (pct(sample.answer, 95) > 500) reasons.push("answer p95 over 500 ms");
  if (pct(sample.join, 95) > 500) reasons.push("join p95 over 500 ms");
  if (pct(sample.board, 95) > 500) reasons.push("board p95 over 500 ms");
  const g = sample.game;
  if (g && (!g.finished || g.questionsPlayed < g.questionsPlanned)) reasons.push("game incomplete");
  return reasons;
}

function report(sample: Sample): void {
  const line = (name: string, values: number[]) =>
    `${name.padEnd(8)} n=${String(values.length).padStart(5)}  p50=${pct(values, 50).toFixed(1).padStart(7)}ms  p95=${pct(values, 95).toFixed(1).padStart(7)}ms`;
  const t = sample.timeouts;
  const codes = Object.entries(sample.errorCodes).map(([code, n]) => `${code}=${n}`);
  console.log(`\nClients ${sample.clients}  phases ${sample.phases}`);
  console.log(line("join", sample.join));
  console.log(line("answer", sample.answer));
  console.log(line("board", sample.board));
  console.log(`errors ${sample.errors} / ops ${sample.ops}    score mismatches ${sample.mismatches}`);
  console.log(
    `timeouts boardPlace=${t.boardPlaceTimeouts} boardCursor=${t.boardCursorTimeouts} answer=${t.answerTimeouts} welcome=${t.welcomeTimeouts} resume=${t.resumeTimeouts}`,
  );
  console.log(`server error codes ${codes.length ? codes.join(" ") : "none"}`);
  const e = sample.boardPlaceEvidence;
  if (e.timedOut) {
    console.log(
      `board.place timeouts ${e.timedOut}: node appeared ${e.nodeAppeared}, server error ${e.serverError}, neither ${e.neither}, unchecked ${e.unchecked}, ack arrived late ${e.lateAck}`,
    );
  }
  if (sample.game) {
    const g = sample.game;
    console.log(
      `game     questions ${g.questionsPlayed}/${g.questionsPlanned}  rounds ${g.roundsCompleted}/${g.roundsTotal}  finished ${g.finished ? "yes" : "no"}`,
    );
  }
  if (sample.fatal) console.log(`fatal    ${sample.fatal}`);
}

function toResult(sample: Sample) {
  return {
    clients: sample.clients,
    phases: sample.phases,
    joinN: sample.join.length,
    joinP50: pct(sample.join, 50),
    joinP95: pct(sample.join, 95),
    answerP50: pct(sample.answer, 50),
    answerP95: pct(sample.answer, 95),
    boardP50: pct(sample.board, 50),
    boardP95: pct(sample.board, 95),
    errors: sample.errors,
    ops: sample.ops,
    mismatches: sample.mismatches,
    timeouts: sample.timeouts,
    errorCodes: sample.errorCodes,
    boardPlaceEvidence: sample.boardPlaceEvidence,
    fatal: sample.fatal ?? null,
    game: sample.game ?? null,
  };
}

let phase = "boot";
const mark = (next: string) => {
  phase = next;
  writeSync(2, `phase ${next}\n`);
};

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const runs = sizes.length ? sizes : [50, 200];
const results: ReturnType<typeof toResult>[] = [];
let target: Target | null = null;
try {
  target = await resolveTarget();
  if (target.remote) {
    console.log(`Remote load test against ${target.wsUrl}`);
  }
  for (const n of runs) {
    const sample = newSample(n);
    try {
      await scenario(n, target, sample);
    } catch (err) {
      sample.fatal = err instanceof Error ? err.message : String(err);
    }
    report(sample);
    results.push(toResult(sample));
    const reasons = failureReasons(sample);
    if (reasons.length) {
      console.error(`load test failed: ${reasons.join("; ")}`);
      process.exitCode = 1;
      break;
    }
  }
} catch (err) {
  console.error(`load test aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  console.log("\nLOAD_TEST_JSON");
  console.log(JSON.stringify(results, null, 2));
  try {
    if (target?.server) await target.server.close();
  } catch (err) {
    console.error(`server close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
