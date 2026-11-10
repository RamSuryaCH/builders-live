// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0

/** Correct answers score base points plus a speed bonus that falls to 0 at the deadline. */
export function pointsFor(
  correct: boolean,
  elapsedMs: number,
  durationMs: number,
  base: number,
  speed: number,
): number {
  if (!correct) return 0;
  if (durationMs <= 0) return base + speed;
  const elapsed = Math.min(Math.max(elapsedMs, 0), durationMs);
  const remaining = 1 - elapsed / durationMs;
  return base + Math.round(speed * remaining);
}

export function pickTeam(counts: Map<string, number>, teamIds: string[]): string {
  let best = teamIds[0];
  let bestN = Number.POSITIVE_INFINITY;
  for (const id of teamIds) {
    const n = counts.get(id) ?? 0;
    if (n < bestN) {
      bestN = n;
      best = id;
    }
  }
  return best;
}
