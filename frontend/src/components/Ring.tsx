import { useEffect, useState } from "react";

export function Ring({
  remainingMs,
  totalMs,
  light = false,
}: {
  remainingMs: number;
  totalMs: number;
  light?: boolean;
}) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return (
    <svg className="ring" viewBox="0 0 72 72" role="img" aria-label={`${seconds} seconds`} style={light ? { color: "white" } : undefined}>
      <circle className="ring-track" cx="36" cy="36" r={r} />
      <circle className="ring-value" cx="36" cy="36" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      <text x="36" y="41" textAnchor="middle">{seconds}</text>
    </svg>
  );
}

export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
