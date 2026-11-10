import { useState } from "react";
import { go, tap } from "../haptics";

export function Landing({ eventName, tagline, groupName }: { eventName: string; tagline: string; groupName: string }) {
  const [code, setCode] = useState("");
  const [hint, setHint] = useState("");
  return (
    <main className="landing">
      <section className="card">
        <div className="brand-mark"><i /> {eventName}</div>
        <h1>{tagline}</h1>
        <p className="lede">{groupName}. Nothing to install, and no account. Enter the room code from the projector.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const next = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (next.length < 4) {
              setHint("Enter the 6-character room code.");
              return;
            }
            tap();
            go(`/join/${next}`);
          }}
        >
          <label htmlFor="code">Room code</label>
          <input id="code" className="code-input" inputMode="text" autoCapitalize="characters" autoComplete="off" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} placeholder="AB23CD" />
          <button className="btn primary full tap" type="submit">Join</button>
          {hint && <p className="fine">{hint}</p>}
        </form>
        <p className="fine">Hosting? Open the host console at /host.</p>
      </section>
    </main>
  );
}
