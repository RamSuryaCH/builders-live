// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0

export type ScreenMode = "lobby" | "battle" | "board" | "qa" | "match";

export type BattlePhase =
  | "idle"
  | "intro"
  | "question"
  | "reveal"
  | "paused"
  | "break"
  | "finished";

export type Presence = "active" | "idle" | "disconnected";

export interface TeamConfig {
  id: string;
  name: string;
  color: string;
}

export interface RoundPlanEntry {
  title?: string;
  intro?: string;
  count?: number;
}

export interface TileConfig {
  id: string;
  label: string;
  group: string;
}

export interface ChallengeConfig {
  id: string;
  text: string;
}

export interface EventConfig {
  eventName: string;
  groupName: string;
  tagline: string;
  eventDate: string;
  region: string;
  roomCap: number;
  expectedAttendees: number;
  description: string;
  teams: TeamConfig[];
  battle: {
    rounds: number;
    questionsPerRound: number;
    questionSeconds: number;
    revealSeconds: number;
    roundBreakSeconds: number;
    introSeconds: number;
    autoAdvanceRounds: boolean;
    pointsBase: number;
    pointsSpeed: number;
  };
  roundPlan: RoundPlanEntry[];
  board: {
    broadcastHz: number;
    rateLimitPerSec: number;
    maxNodes: number;
    maxEdges: number;
    tiles: TileConfig[];
    challenges: ChallengeConfig[];
  };
  qa: {
    maxQuestionLength: number;
    rateLimitPerMin: number;
  };
  match: {
    groupSizeMin: number;
    groupSizeMax: number;
    interests: string[];
  };
  sessionTtlHours: number;
  dataTtlHours: number;
  hostSessionHours: number;
  heartbeatSeconds: number;
  idleSeconds: number;
  disconnectSeconds: number;
  login: {
    maxFailures: number;
    windowSeconds: number;
    lockoutSeconds: number;
  };
}

export interface Choice {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: Choice[];
  correct: string;
  explanation: string;
}

export interface Bucket {
  t: number;
  n: number;
}

export interface AnswerRecord {
  questionId: string;
  choiceId: string;
  correct: boolean;
  points: number;
  receivedAt: number;
  clientMsgId: string;
  elapsedMs: number;
}

export interface Player {
  id: string;
  deviceId: string;
  name: string;
  teamId: string;
  score: number;
  connected: boolean;
  lastSeen: number;
  lastAction: number;
  joinedAt: number;
  kicked: boolean;
  answers: Record<string, AnswerRecord>;
  buckets: { board: Bucket; qa: Bucket; cursor: Bucket; vote: Bucket };
  version: number;
}

export interface BoardNode {
  id: string;
  tileType: string;
  x: number;
  y: number;
  by: string;
  byName: string;
}

export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  by: string;
}

export interface Cursor {
  playerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  ts: number;
}

export interface BoardState {
  locked: boolean;
  challengeId: string | null;
  nodes: BoardNode[];
  edges: BoardEdge[];
  cursors: Record<string, Cursor>;
}

export interface QaItem {
  id: string;
  text: string;
  by: string;
  byName: string;
  upvotes: number;
  voters: string[];
  answered: boolean;
  hidden: boolean;
  createdAt: number;
}

export interface MatchGroup {
  id: string;
  playerIds: string[];
  names: string[];
  interest: string;
}

export interface RoundRuntime {
  title: string;
  intro: string | null;
  questionIds: string[];
}

export interface BattleState {
  phase: BattlePhase;
  pausedFrom: "intro" | "question" | "reveal" | "break" | null;
  round: number;
  questionIndex: number;
  questionId: string | null;
  rounds: RoundRuntime[];
  startedAt: number | null;
  endsAt: number | null;
  pausedRemainingMs: number | null;
  generation: number;
}

export interface RoomState {
  code: string;
  createdAt: number;
  locked: boolean;
  screenMode: ScreenMode;
  players: Record<string, Player>;
  blockedDeviceIds: string[];
  battle: BattleState;
  board: BoardState;
  qa: QaItem[];
  matches: MatchGroup[];
  interests: Record<string, string[]>;
  seq: number;
  version: number;
}

export interface Features {
  bedrockSummary: boolean;
}
