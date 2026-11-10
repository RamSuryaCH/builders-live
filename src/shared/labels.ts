// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type { PublicBattle } from "./protocol.js";

/** Same round header and question line on the phone and the projector. */
export function battleLabels(
  battle: Pick<PublicBattle, "round" | "rounds" | "questionIndex" | "questionsInRound" | "roundTitle">,
): { round: string; question: string } {
  const roundNo = Math.max(battle.round, 1);
  const title = battle.roundTitle?.trim();
  const round = title
    ? `ROUND ${roundNo} OF ${battle.rounds} · ${title.toLocaleUpperCase("en-US")}`
    : `ROUND ${roundNo} OF ${battle.rounds}`;
  const question = `QUESTION ${battle.questionIndex + 1} OF ${battle.questionsInRound}`;
  return { round, question };
}
