// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type {
  AdminPlayer,
  AdminQuestionStat,
  AdminTeamStat,
  AdminView,
  LobbyView,
  PlayerView,
  PublicBattle,
  PublicBoard,
  PublicCursor,
  PublicGroup,
  PublicQa,
  ScreenView,
  Standings,
} from "./protocol.js";
import type { EventConfig, Features, Player, Presence, QuizQuestion, RoomState } from "./types.js";
import { findQuestion, roster } from "./engine.js";
import type { EngineEnv } from "./engine.js";

function presence(player: Player, now: number, config: EventConfig): Presence {
  if (!player.connected || now - player.lastSeen > config.disconnectSeconds * 1000) return "disconnected";
  if (now - player.lastAction > config.idleSeconds * 1000) return "idle";
  return "active";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((p) => p[0] ?? "").join("");
  return (letters || name.slice(0, 2)).toUpperCase();
}

export function lobbyView(state: RoomState, config: EventConfig): LobbyView {
  const people = roster(state);
  return {
    joined: people.length,
    cap: config.roomCap,
    locked: state.locked,
    teams: config.teams.map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
      members: people
        .filter((p) => p.teamId === team.id)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({ id: p.id, name: p.name, initials: initials(p.name) })),
    })),
  };
}

function durationMs(state: RoomState, config: EventConfig): number {
  const phase = state.battle.phase === "paused" ? state.battle.pausedFrom : state.battle.phase;
  if (phase === "intro") return config.battle.introSeconds * 1000;
  if (phase === "question") return config.battle.questionSeconds * 1000;
  if (phase === "reveal") return config.battle.revealSeconds * 1000;
  if (phase === "break") return config.battle.roundBreakSeconds * 1000;
  return 0;
}

export function battleView(state: RoomState, env: EngineEnv, playerId?: string): PublicBattle {
  const battle = state.battle;
  const round = battle.rounds[battle.round - 1];
  const showing = battle.phase === "paused" ? battle.pausedFrom : battle.phase;
  const quiz = showing === "question" || showing === "reveal" ? findQuestion(env, battle.questionId) : null;
  const yours = playerId && quiz ? state.players[playerId]?.answers[quiz.id] : undefined;
  let reveal = null;
  if (showing === "reveal" && quiz) {
    const counts = quiz.choices.map((c) => ({
      id: c.id,
      n: roster(state).filter((p) => p.answers[quiz.id]?.choiceId === c.id).length,
    }));
    reveal = { correctId: quiz.correct, explanation: quiz.explanation, counts };
  }
  return {
    phase: battle.phase,
    round: battle.round,
    rounds: battle.rounds.length || env.config.roundPlan.length,
    questionIndex: battle.questionIndex,
    questionsInRound: round?.questionIds.length ?? env.config.battle.questionsPerRound,
    roundTitle: round?.title ?? null,
    roundIntro: round?.intro ?? null,
    endsAt: battle.endsAt,
    durationMs: durationMs(state, env.config),
    pausedRemainingMs: battle.pausedRemainingMs,
    question: quiz
      ? { id: quiz.id, prompt: quiz.prompt, choices: quiz.choices.map((c) => ({ id: c.id, text: c.text })) }
      : null,
    reveal,
    yourAnswer: yours ? { choiceId: yours.choiceId, points: yours.points, correct: yours.correct } : null,
  };
}

export function standingsView(state: RoomState, config: EventConfig): Standings {
  const people = roster(state);
  const teams = config.teams.map((team) => ({
    id: team.id,
    name: team.name,
    color: team.color,
    score: people.filter((p) => p.teamId === team.id).reduce((sum, p) => sum + p.score, 0),
    members: people.filter((p) => p.teamId === team.id).length,
  }));
  teams.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const topPlayers = [...people]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((p) => ({ id: p.id, name: p.name, teamId: p.teamId, score: p.score }));
  return { teams, topPlayers };
}

export function boardView(state: RoomState, config: EventConfig): PublicBoard {
  const challenge = config.board.challenges.find((c) => c.id === state.board.challengeId);
  return {
    locked: state.board.locked,
    challenge: challenge?.text ?? null,
    nodes: state.board.nodes.map((n) => ({
      id: n.id,
      tileType: n.tileType,
      x: n.x,
      y: n.y,
      byName: n.byName,
    })),
    edges: state.board.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };
}

export function cursorsView(state: RoomState, now: number): PublicCursor[] {
  return Object.values(state.board.cursors)
    .filter((c) => now - c.ts < 5000)
    .map((c) => ({ playerId: c.playerId, name: c.name, color: c.color, x: c.x, y: c.y }));
}

export function qaView(state: RoomState, viewerId: string | null, host: boolean): PublicQa[] {
  return state.qa
    .filter((q) => host || !q.hidden)
    .map((q) => ({
      id: q.id,
      text: q.text,
      byName: q.byName,
      upvotes: q.upvotes,
      answered: q.answered,
      hidden: q.hidden,
      mine: viewerId != null && q.by === viewerId,
      voted: viewerId != null && q.voters.includes(viewerId),
      createdAt: q.createdAt,
    }))
    .sort((a, b) => b.upvotes - a.upvotes || a.createdAt - b.createdAt);
}

export function groupsView(state: RoomState, viewerId: string | null): PublicGroup[] {
  return state.matches.map((g) => ({
    id: g.id,
    names: g.names,
    interest: g.interest,
    yours: viewerId != null && g.playerIds.includes(viewerId),
  }));
}

export function playerView(state: RoomState, env: EngineEnv, playerId: string, now: number, features: Features): PlayerView {
  const player = state.players[playerId];
  const team = env.config.teams.find((t) => t.id === player.teamId)!;
  const group = groupsView(state, playerId).find((g) => g.yours) ?? null;
  return {
    you: {
      id: player.id,
      name: player.name,
      teamId: player.teamId,
      teamName: team.name,
      teamColor: team.color,
      score: player.score,
      status: presence(player, now, env.config),
    },
    screenMode: state.screenMode,
    joined: roster(state).length,
    battle: battleView(state, env, playerId),
    standings: standingsView(state, env.config),
    board: boardView(state, env.config),
    qa: qaView(state, playerId, false),
    interests: state.interests[playerId] ?? [],
    yourGroup: group,
    features,
    version: state.version,
  };
}

export function screenView(state: RoomState, env: EngineEnv, now: number, features: Features): ScreenView {
  return {
    screenMode: state.screenMode,
    joined: roster(state).length,
    cap: env.config.roomCap,
    locked: state.locked,
    lobby: lobbyView(state, env.config),
    battle: battleView(state, env),
    standings: standingsView(state, env.config),
    board: boardView(state, env.config),
    cursors: cursorsView(state, now),
    qa: qaView(state, null, false).slice(0, 8),
    groups: groupsView(state, null),
    features,
    version: state.version,
  };
}

function accuracy(correct: number, answered: number): number {
  if (!answered) return 0;
  return correct / answered;
}

export function adminView(state: RoomState, env: EngineEnv, now: number, features: Features): AdminView {
  const config = env.config;
  const people = Object.values(state.players);
  const live = people.filter((p) => !p.kicked);
  const statuses = live.map((p) => presence(p, now, config));
  const players: AdminPlayer[] = people
    .map((p) => {
      const answers = Object.values(p.answers);
      const correct = answers.filter((a) => a.correct).length;
      return {
        id: p.id,
        name: p.name,
        teamId: p.teamId,
        score: p.score,
        status: p.kicked ? "disconnected" : presence(p, now, config),
        answered: answers.length,
        correct,
        accuracy: accuracy(correct, answers.length),
        currentAnswered: state.battle.questionId ? Boolean(p.answers[state.battle.questionId]) : false,
        kicked: p.kicked,
      };
    })
    .sort((a, b) => Number(a.kicked) - Number(b.kicked) || b.score - a.score || a.name.localeCompare(b.name));

  const questions: AdminQuestionStat[] = [];
  state.battle.rounds.forEach((round, r) => {
    round.questionIds.forEach((id, index) => {
      const quiz = env.questions.find((q) => q.id === id);
      const answers = live.map((p) => p.answers[id]).filter(Boolean);
      const correct = answers.filter((a) => a!.correct).length;
      questions.push({
        id,
        prompt: quiz?.prompt ?? id,
        round: r + 1,
        index,
        answered: answers.length,
        correct,
        accuracy: accuracy(correct, answers.length),
      });
    });
  });

  const teams: AdminTeamStat[] = config.teams.map((team) => {
    const members = live.filter((p) => p.teamId === team.id);
    let answered = 0;
    let correct = 0;
    for (const p of members) {
      const answers = Object.values(p.answers);
      answered += answers.length;
      correct += answers.filter((a) => a.correct).length;
    }
    return {
      id: team.id,
      name: team.name,
      color: team.color,
      score: members.reduce((sum, p) => sum + p.score, 0),
      members: members.length,
      answered,
      correct,
      accuracy: accuracy(correct, answered),
    };
  });

  return {
    code: state.code,
    locked: state.locked,
    screenMode: state.screenMode,
    joined: live.length,
    cap: config.roomCap,
    counts: {
      active: statuses.filter((s) => s === "active").length,
      idle: statuses.filter((s) => s === "idle").length,
      disconnected: statuses.filter((s) => s === "disconnected").length,
    },
    battle: battleView(state, env),
    standings: standingsView(state, config),
    teams,
    players,
    questions,
    board: boardView(state, config),
    qa: qaView(state, null, true),
    groups: groupsView(state, null),
    features,
    version: state.version,
  };
}

export function topQuestions(state: RoomState, n: number): { text: string; upvotes: number }[] {
  return [...state.qa]
    .filter((q) => !q.hidden)
    .sort((a, b) => b.upvotes - a.upvotes || a.createdAt - b.createdAt)
    .slice(0, n)
    .map((q) => ({ text: q.text, upvotes: q.upvotes }));
}

export type { QuizQuestion };
