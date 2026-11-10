// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import raw from "../../content/questions.json" with { type: "json" };
import type { EventConfig, QuizQuestion } from "./types.js";

export function loadQuestions(): QuizQuestion[] {
  return raw as QuizQuestion[];
}

export function validateQuestions(questions: QuizQuestion[], config: EventConfig): string[] {
  const errors: string[] = [];
  const need = config.battle.rounds * config.battle.questionsPerRound;
  if (questions.length < need) errors.push(`need at least ${need} questions, found ${questions.length}`);
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) errors.push(`duplicate question id ${q.id}`);
    ids.add(q.id);
    if (!q.prompt.trim()) errors.push(`${q.id} missing prompt`);
    if (!q.explanation.trim()) errors.push(`${q.id} missing explanation`);
    if (q.choices.length !== 4) errors.push(`${q.id} needs 4 choices`);
    if (!q.choices.some((c) => c.id === q.correct)) errors.push(`${q.id} correct id is not a choice`);
    const choiceIds = new Set(q.choices.map((c) => c.id));
    if (choiceIds.size !== q.choices.length) errors.push(`${q.id} has duplicate choice ids`);
  }
  return errors;
}
