export function tap(ms = 12): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  navigator.vibrate?.(ms);
}

export function deviceId(): string {
  const key = "bl.device";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID?.() ?? `d${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  localStorage.setItem(key, id);
  return id;
}

export function go(path: string): void {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
