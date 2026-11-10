import type { PlayerView } from "@shared/protocol";

export interface PlayerSession {
  token: string;
  playerId: string;
  name: string;
}

export function loadSession(code: string): PlayerSession | null {
  const raw = localStorage.getItem(`bl.session.${code}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlayerSession;
    if (!parsed.token || !parsed.playerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(code: string, session: PlayerSession): void {
  localStorage.setItem(`bl.session.${code}`, JSON.stringify(session));
}

export function clearSession(code: string): void {
  localStorage.removeItem(`bl.session.${code}`);
}

export function rememberScore(view: PlayerView): number {
  return view.you.score;
}
