// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import raw from "../../content/event.json" with { type: "json" };
import type { EventConfig } from "./types.js";

export function loadConfig(): EventConfig {
  return raw as EventConfig;
}

/** Structural checks so a customised event file still boots. The shipped defaults are asserted in tests. */
export function validateConfig(config: EventConfig): string[] {
  const errors: string[] = [];
  if (!config.eventName?.trim()) errors.push("eventName is required");
  if (!Array.isArray(config.teams) || config.teams.length < 2) errors.push("at least 2 teams are required");
  if (config.teams.length > 16) errors.push("keep teams to 16 or fewer");
  const ids = new Set<string>();
  for (const team of config.teams ?? []) {
    if (ids.has(team.id)) errors.push(`duplicate team id ${team.id}`);
    ids.add(team.id);
    if (!/^#[0-9A-Fa-f]{6}$/.test(team.color)) errors.push(`bad color for ${team.name}`);
  }
  const b = config.battle;
  if (!b || b.rounds < 1 || b.questionsPerRound < 1) errors.push("battle rounds are not configured");
  if (b && (b.questionSeconds < 5 || b.questionSeconds > 120)) errors.push("questionSeconds must be between 5 and 120");
  if (config.roundPlan.length !== config.battle?.rounds) errors.push("roundPlan length must match battle.rounds");
  if (config.roomCap < 2) errors.push("roomCap must be at least 2");
  if (config.board.broadcastHz < 1 || config.board.broadcastHz > 10) {
    errors.push("board.broadcastHz must be between 1 and 10");
  }
  if (config.match.groupSizeMin < 2 || config.match.groupSizeMax < config.match.groupSizeMin) {
    errors.push("match group sizes are invalid");
  }
  return errors;
}
