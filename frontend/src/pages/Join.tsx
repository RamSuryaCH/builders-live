import { useState } from "react";
import type { ServerMessage } from "@shared/protocol";
import { deviceId, go, tap } from "../haptics";
import { LiveSocket, wsUrl } from "../net";
import { loadSession, saveSession } from "../session";
import { useEffect } from "react";

export function Join({ code, eventName }: { code: string; eventName: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loadSession(code)) go(`/play/${code}`);
  }, [code]);

  return (
    <main className="join">
      <section className="card">
        <div className="brand-mark"><i /> {eventName}</div>
        <h1>Room {code}</h1>
        <p className="lede">Your display name is all we need. You will be in within a few seconds.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            tap();
            const sock = new LiveSocket(wsUrl(), {
              onOpen: (send) => send({ type: "join", roomCode: code, displayName: name, deviceId: deviceId(), clientTs: Date.now() }),
              onMessage: (msg: ServerMessage) => {
                if (msg.type === "welcome") {
                  saveSession(code, { token: msg.token, playerId: msg.playerId, name: msg.state.you.name });
                  sock.stop();
                  go(`/play/${code}`);
                } else if (msg.type === "error") {
                  setError(msg.message);
                  setBusy(false);
                  sock.stop();
                }
              },
            });
            sock.start();
          }}
        >
          <label htmlFor="name">Display name</label>
          <input id="name" type="text" autoComplete="nickname" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" />
          <button className="btn primary full tap" type="submit" disabled={busy}>{busy ? "Joining…" : "I'm in"}</button>
          {error && <p className="fine">{error}</p>}
        </form>
      </section>
    </main>
  );
}
