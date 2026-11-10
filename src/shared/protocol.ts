// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type { Features, Presence, ScreenMode } from "./types.js";

export type { ScreenMode };

export interface PublicChoice {
  id: string;
  text: string;
}

export interface PublicQuestion {
  id: string;
  prompt: string;
  choices: PublicChoice[];
}

export interface PublicReveal {
  correctId: string;
  explanation: string;
  counts: { id: string; n: number }[];
}

export interface PublicBattle {
  phase: string;
  round: number;
  rounds: number;
  questionIndex: number;
  questionsInRound: number;
  roundTitle: string | null;
  roundIntro: string | null;
  endsAt: number | null;
  durationMs: number;
  pausedRemainingMs: number | null;
  question: PublicQuestion | null;
  reveal: PublicReveal | null;
  yourAnswer: { choiceId: string; points: number; correct: boolean } | null;
}

export interface TeamStanding {
  id: string;
  name: string;
  color: string;
  score: number;
  members: number;
}

export interface PlayerStanding {
  id: string;
  name: string;
  teamId: string;
  score: number;
}

export interface Standings {
  teams: TeamStanding[];
  topPlayers: PlayerStanding[];
}

export interface PublicNode {
  id: string;
  tileType: string;
  x: number;
  y: number;
  byName: string;
}

export interface PublicEdge {
  id: string;
  from: string;
  to: string;
}

export interface PublicBoard {
  locked: boolean;
  challenge: string | null;
  nodes: PublicNode[];
  edges: PublicEdge[];
}

export interface PublicCursor {
  playerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

export interface PublicQa {
  id: string;
  text: string;
  byName: string;
  upvotes: number;
  answered: boolean;
  hidden: boolean;
  mine: boolean;
  voted: boolean;
  createdAt: number;
}

export interface PublicGroup {
  id: string;
  names: string[];
  interest: string;
  yours: boolean;
}

export interface LobbyMember {
  id: string;
  name: string;
  initials: string;
}

export interface LobbyTeam {
  id: string;
  name: string;
  color: string;
  members: LobbyMember[];
}

export interface LobbyView {
  joined: number;
  cap: number;
  locked: boolean;
  teams: LobbyTeam[];
}

export interface PlayerSelf {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  teamColor: string;
  score: number;
  status: Presence;
}

export interface PlayerView {
  you: PlayerSelf;
  screenMode: ScreenMode;
  joined: number;
  battle: PublicBattle;
  standings: Standings;
  board: PublicBoard;
  qa: PublicQa[];
  interests: string[];
  yourGroup: PublicGroup | null;
  features: Features;
  version: number;
}

export interface ScreenView {
  screenMode: ScreenMode;
  joined: number;
  cap: number;
  locked: boolean;
  lobby: LobbyView;
  battle: PublicBattle;
  standings: Standings;
  board: PublicBoard;
  cursors: PublicCursor[];
  qa: PublicQa[];
  groups: PublicGroup[];
  features: Features;
  version: number;
}

export interface AdminPlayer {
  id: string;
  name: string;
  teamId: string;
  score: number;
  status: Presence;
  answered: number;
  correct: number;
  accuracy: number;
  currentAnswered: boolean;
  kicked: boolean;
}

export interface AdminQuestionStat {
  id: string;
  prompt: string;
  round: number;
  index: number;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface AdminTeamStat {
  id: string;
  name: string;
  color: string;
  score: number;
  members: number;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface AdminView {
  code: string;
  locked: boolean;
  screenMode: ScreenMode;
  joined: number;
  cap: number;
  counts: { active: number; idle: number; disconnected: number };
  battle: PublicBattle;
  standings: Standings;
  teams: AdminTeamStat[];
  players: AdminPlayer[];
  questions: AdminQuestionStat[];
  board: PublicBoard;
  qa: PublicQa[];
  groups: PublicGroup[];
  features: Features;
  version: number;
}

export interface AnswerAckMessage {
  questionId: string;
  choiceId: string;
  clientMsgId: string;
  duplicate: boolean;
  correct: boolean;
  points: number;
  totalScore: number;
}

export type ClientMessage =
  | { type: "ping"; clientTs: number; v?: number }
  | { type: "host.login"; secret: string; clientTs?: number }
  | { type: "host.createRoom"; token: string; clientTs?: number }
  | { type: "host.attach"; token: string; roomCode: string; clientTs?: number }
  | { type: "host.lock"; token: string; locked: boolean; clientTs?: number }
  | { type: "host.mode"; token: string; mode: ScreenMode; clientTs?: number }
  | { type: "host.reset"; token: string; clientTs?: number }
  | { type: "host.start"; token: string; clientTs?: number }
  | { type: "host.pause"; token: string; clientTs?: number }
  | { type: "host.resume"; token: string; clientTs?: number }
  | { type: "host.skip"; token: string; clientTs?: number }
  | { type: "host.skipRound"; token: string; clientTs?: number }
  | { type: "host.stop"; token: string; clientTs?: number }
  | { type: "host.kick"; token: string; playerId: string; block: boolean; clientTs?: number }
  | { type: "host.board.clear"; token: string; clientTs?: number }
  | { type: "host.board.lock"; token: string; locked: boolean; clientTs?: number }
  | { type: "host.board.challenge"; token: string; challengeId: string | null; clientTs?: number }
  | { type: "host.qa.answered"; token: string; questionId: string; answered: boolean; clientTs?: number }
  | { type: "host.qa.hide"; token: string; questionId: string; hidden: boolean; clientTs?: number }
  | { type: "host.summarise"; token: string; clientTs?: number }
  | { type: "host.snapshot"; token: string; clientTs?: number }
  | { type: "screen.join"; roomCode: string; clientTs?: number }
  | { type: "join"; roomCode: string; displayName: string; deviceId: string; clientTs?: number }
  | { type: "resume"; token: string; deviceId: string; clientTs?: number }
  | { type: "subscribe"; views: string[]; clientTs?: number }
  | { type: "answer"; questionId: string; choiceId: string; clientMsgId: string; clientTs?: number }
  | { type: "board.place"; tileType: string; x: number; y: number; clientMsgId: string; clientTs?: number }
  | { type: "board.move"; nodeId: string; x: number; y: number; clientMsgId: string; clientTs?: number }
  | { type: "board.connect"; from: string; to: string; clientMsgId: string; clientTs?: number }
  | { type: "board.delete"; nodeId: string; clientMsgId: string; clientTs?: number }
  | { type: "board.cursor"; x: number; y: number; clientMsgId?: string; clientTs?: number }
  | { type: "qa.post"; text: string; clientMsgId: string; clientTs?: number }
  | { type: "qa.upvote"; questionId: string; clientTs?: number }
  | { type: "match.set"; interests: string[]; clientTs?: number };

export type ServerMessage =
  | { type: "pong"; clientTs: number; serverTs: number; version: number }
  | { type: "error"; code: string; message: string; clientMsgId?: string; serverTs: number }
  | { type: "host.welcome"; token: string; expiresAt: number; features: Features; serverTs: number }
  | { type: "room.created"; roomCode: string; joinPath: string; screenPath: string; serverTs: number }
  | { type: "welcome"; token: string; playerId: string; roomCode: string; state: PlayerView; serverTs: number; clientTs?: number }
  | { type: "state"; role: "player" | "screen" | "host"; state: PlayerView | ScreenView | AdminView; serverTs: number }
  | { type: "answer.ack"; ack: AnswerAckMessage; serverTs: number; clientTs?: number }
  | { type: "ack"; clientMsgId: string; serverTs: number; clientTs?: number }
  | { type: "kicked"; message: string; serverTs: number }
  | { type: "battle"; battle: PublicBattle; standings: Standings; screenMode: ScreenMode; serverTs: number }
  | { type: "mode"; screenMode: ScreenMode; serverTs: number }
  | { type: "standings"; standings: Standings; serverTs: number }
  | { type: "board"; board: PublicBoard; serverTs: number }
  | { type: "cursors"; cursors: PublicCursor[]; serverTs: number }
  | { type: "qa"; items: PublicQa[]; serverTs: number }
  | { type: "match"; yours: PublicGroup | null; groups?: PublicGroup[]; serverTs: number }
  | { type: "lobby"; lobby: LobbyView; serverTs: number }
  | { type: "admin"; admin: AdminView; serverTs: number; clientTs?: number }
  | { type: "summary"; text: string; serverTs: number };

export function roomCodeOk(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code);
}
