import type { ClientMessage, ServerMessage } from "@shared/protocol";

export function wsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

type Send = (msg: ClientMessage) => void;

export class LiveSocket {
  private ws: WebSocket | null = null;
  private backoff = 400;
  private closed = false;
  private queue: ClientMessage[] = [];
  private beat = 0;
  status: "connecting" | "live" | "reconnecting" = "connecting";

  constructor(
    private url: string,
    private handlers: {
      onMessage: (msg: ServerMessage) => void;
      onStatus?: (status: LiveSocket["status"]) => void;
      onOpen?: (send: Send) => void;
    },
  ) {}

  start(): void {
    this.open();
    this.beat = window.setInterval(() => {
      this.send({ type: "ping", clientTs: Date.now(), v: this.version }, true);
    }, 20_000);
  }

  version = 0;

  stop(): void {
    this.closed = true;
    window.clearInterval(this.beat);
    this.ws?.close();
  }

  send(msg: ClientMessage, dropIfDown = false): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (!dropIfDown && msg.type !== "ping") this.queue.push(msg);
  }

  private setStatus(status: LiveSocket["status"]): void {
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 400;
      this.setStatus("live");
      this.handlers.onOpen?.((msg) => ws.send(JSON.stringify(msg)));
      const pending = this.queue.splice(0);
      const seen = new Set<string>();
      const ordered: ClientMessage[] = [];
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const msg = pending[i];
        const id = "clientMsgId" in msg ? msg.clientMsgId : undefined;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        ordered.push(msg);
      }
      for (const msg of ordered.reverse()) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.setStatus("reconnecting");
      const wait = this.backoff + Math.random() * 250;
      this.backoff = Math.min(10_000, this.backoff * 2);
      window.setTimeout(() => this.open(), wait);
    };
  }
}
