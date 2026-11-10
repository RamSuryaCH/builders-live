import { useEffect, useRef, useState } from "react";
import { loadConfig } from "@shared/event-config";
import { battleLabels } from "@shared/labels";
import type { PlayerView, PublicBattle, PublicCursor, PublicGroup, PublicQa, ServerMessage, Standings } from "@shared/protocol";
import { BoardView } from "../components/Board";
import { Ring, useNow } from "../components/Ring";
import { deviceId, go, tap } from "../haptics";
import { LiveSocket, wsUrl } from "../net";
import { clearSession, loadSession } from "../session";

const event = loadConfig();
type Tab = "battle" | "board" | "qa" | "match";

const tabs: { id: Tab; label: string }[] = [
  { id: "battle", label: "Team Battle" },
  { id: "board", label: "Build Board" },
  { id: "qa", label: "Live Q&A" },
  { id: "match", label: "Builder Match" },
];

export function Play({ code }: { code: string }) {
  const session = loadSession(code);
  const [view, setView] = useState<PlayerView | null>(null);
  const [tab, setTab] = useState<Tab>("battle");
  const [status, setStatus] = useState("connecting");
  const [pending, setPending] = useState<string | null>(null);
  const [pop, setPop] = useState<{ id: number; points: number } | null>(null);
  const [toast, setToast] = useState("");
  const [kicked, setKicked] = useState("");
  const [qaText, setQaText] = useState("");
  const [picks, setPicks] = useState<string[]>([]);
  const [cursors, setCursors] = useState<PublicCursor[]>([]);
  const [offset, setOffset] = useState(0);
  const sock = useRef<LiveSocket | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!session) {
      go(`/join/${code}`);
      return;
    }
    const live = new LiveSocket(wsUrl(), {
      onStatus: setStatus,
      onOpen: (send) => {
        const current = loadSession(code);
        if (!current) return;
        send({ type: "resume", token: current.token, deviceId: deviceId(), clientTs: Date.now() });
        send({ type: "subscribe", views: [tab], clientTs: Date.now() });
      },
      onMessage: (msg) => onMessage(msg),
    });
    sock.current = live;
    live.start();
    return () => live.stop();
    // The socket lives for the room, not for every tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function noteTime(serverTs: number) {
    setOffset(serverTs - Date.now());
  }

  function onMessage(msg: ServerMessage) {
    if ("serverTs" in msg && typeof msg.serverTs === "number") noteTime(msg.serverTs);
    if (msg.type === "welcome" || (msg.type === "state" && msg.role === "player")) {
      const state = msg.type === "welcome" ? msg.state : (msg.state as PlayerView);
      setView(state);
      setPicks(state.interests);
      if (sock.current) sock.current.version = state.version;
    } else if (msg.type === "battle") {
      setView((v) => (v ? { ...v, battle: msg.battle, standings: msg.standings } : v));
    } else if (msg.type === "standings") {
      setView((v) => (v ? { ...v, standings: msg.standings } : v));
    } else if (msg.type === "board") {
      setView((v) => (v ? { ...v, board: msg.board } : v));
    } else if (msg.type === "cursors") {
      setCursors(msg.cursors);
    } else if (msg.type === "qa") {
      setView((v) => (v ? { ...v, qa: msg.items } : v));
    } else if (msg.type === "match") {
      setView((v) => (v ? { ...v, yourGroup: msg.yours } : v));
    } else if (msg.type === "answer.ack") {
      setPending(msg.ack.choiceId);
      setView((v) => {
        if (!v) return v;
        const battle: PublicBattle = {
          ...v.battle,
          yourAnswer: { choiceId: msg.ack.choiceId, points: msg.ack.points, correct: msg.ack.correct },
        };
        return { ...v, you: { ...v.you, score: msg.ack.totalScore }, battle };
      });
      if (!msg.ack.duplicate && msg.ack.points > 0) setPop({ id: Date.now(), points: msg.ack.points });
    } else if (msg.type === "error") {
      setToast(msg.message);
      if (msg.code === "closed" || msg.code === "bad_choice") setPending(null);
    } else if (msg.type === "kicked") {
      clearSession(code);
      setKicked(msg.message);
    } else if (msg.type === "mode" && msg.screenMode === "battle") {
      setTab("battle");
    }
  }

  useEffect(() => {
    sock.current?.send({ type: "subscribe", views: [tab], clientTs: Date.now() });
  }, [tab]);

  if (!session) return null;
  if (kicked) {
    return (
      <main className="join">
        <section className="card">
          <h1>Removed</h1>
          <p>{kicked}</p>
        </section>
      </main>
    );
  }

  const synced = now + offset;
  return (
    <main className="play">
      {status !== "live" && <div className="banner">{status === "connecting" ? "Connecting…" : "Reconnecting…"}</div>}
      <header className="play-head">
        <div className="who">
          <span className="avatar" style={{ background: view?.you.teamColor ?? "#FF9900" }}>
            {(view?.you.name ?? session.name).slice(0, 1)}
          </span>
          <div>
            <strong>{view?.you.name ?? session.name}</strong>
            <span>{view ? `Team ${view.you.teamName}` : "Joining…"}</span>
          </div>
        </div>
        <div className="score-wrap">
          <b>{view?.you.score ?? 0}</b>
          {pop && <span className="score-pop" key={pop.id}>+{pop.points}</span>}
        </div>
      </header>
      <section className="panel">
        {toast && <div className="toast">{toast}</div>}
        {!view && <p className="waiting">Getting the room ready…</p>}
        {view && tab === "battle" && (
          <Battle
            battle={view.battle}
            standings={view.standings}
            pending={pending}
            now={synced}
            onAnswer={(choiceId) => {
              if (!view.battle.question || view.battle.phase !== "question") return;
              if (view.battle.yourAnswer || pending) return;
              tap(15);
              setPending(choiceId);
              sock.current?.send({
                type: "answer",
                questionId: view.battle.question.id,
                choiceId,
                clientMsgId: `a-${view.battle.question.id}-${deviceId()}`,
                clientTs: Date.now(),
              });
            }}
          />
        )}
        {view && tab === "board" && (
          <BoardView
            board={view.board}
            cursors={cursors}
            editable
            onPlace={(tile, x, y) => sock.current?.send({ type: "board.place", tileType: tile, x, y, clientMsgId: crypto.randomUUID(), clientTs: Date.now() })}
            onMove={(id, x, y) => sock.current?.send({ type: "board.move", nodeId: id, x, y, clientMsgId: `m-${id}`, clientTs: Date.now() })}
            onCursor={(x, y) => sock.current?.send({ type: "board.cursor", x, y, clientTs: Date.now() }, true)}
            onConnect={(from, to) => sock.current?.send({ type: "board.connect", from, to, clientMsgId: crypto.randomUUID(), clientTs: Date.now() })}
            onDelete={(id) => sock.current?.send({ type: "board.delete", nodeId: id, clientMsgId: crypto.randomUUID(), clientTs: Date.now() })}
          />
        )}
        {view && tab === "qa" && (
          <Qa
            items={view.qa}
            text={qaText}
            onText={setQaText}
            onPost={() => {
              tap();
              sock.current?.send({ type: "qa.post", text: qaText, clientMsgId: crypto.randomUUID(), clientTs: Date.now() });
              setQaText("");
            }}
            onVote={(id) => {
              tap(8);
              sock.current?.send({ type: "qa.upvote", questionId: id, clientTs: Date.now() });
            }}
          />
        )}
        {view && tab === "match" && (
          <Match
            picks={picks}
            group={view.yourGroup}
            onToggle={(interest) => setPicks((cur) => (cur.includes(interest) ? cur.filter((i) => i !== interest) : [...cur, interest]))}
            onSave={() => {
              tap();
              sock.current?.send({ type: "match.set", interests: picks, clientTs: Date.now() });
            }}
          />
        )}
      </section>
      <nav className="tabbar" aria-label="Features">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? "on" : ""} type="button" onClick={() => { tap(6); setTab(item.id); }}>
            <Icon name={item.id} />
            {item.label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function Battle({
  battle,
  pending,
  now,
  onAnswer,
}: {
  battle: PublicBattle;
  standings: Standings;
  pending: string | null;
  now: number;
  onAnswer: (id: string) => void;
}) {
  const remaining = battle.phase === "paused" ? battle.pausedRemainingMs ?? 0 : battle.endsAt ? Math.max(0, battle.endsAt - now) : 0;
  const labels = battleLabels(battle);
  if (battle.phase === "idle") return <p className="waiting">Waiting for the host to start Team Battle.</p>;
  if (battle.phase === "finished") return <p className="waiting">Team Battle is over. Your score stays on the board.</p>;
  if (battle.phase === "intro" || (battle.phase === "paused" && !battle.question)) {
    return (
      <article className="story">
        <div className="q-top">
          <div>
            <p className="kicker">{labels.round}</p>
            <h2>{battle.roundIntro || battle.roundTitle}</h2>
          </div>
          <Ring remainingMs={remaining} totalMs={battle.durationMs} light />
        </div>
      </article>
    );
  }
  if (battle.phase === "break") {
    return <p className="waiting">{battle.roundTitle ?? `Round ${battle.round}`} is done. Next round in a moment.</p>;
  }
  const mine = battle.yourAnswer?.choiceId ?? pending;
  return (
    <article className="q-card">
      <div className="q-top">
        <div>
          <p className="kicker">{labels.round}</p>
          <p className="subkicker">{labels.question}</p>
          <h2>{battle.question?.prompt}</h2>
        </div>
        <div>
            {battle.phase === "paused" && <p className="kicker">Paused</p>}
            <Ring remainingMs={remaining} totalMs={battle.durationMs} />
          </div>
      </div>
      <div className="choices">
        {battle.question?.choices.map((choice) => {
          const correct = battle.reveal?.correctId === choice.id;
          const wrong = mine === choice.id && battle.reveal && !correct;
          return (
            <button
              key={choice.id}
              className={`choice tap ${mine === choice.id ? "is-mine" : ""} ${correct ? "is-correct" : ""} ${wrong ? "is-wrong" : ""}`}
              type="button"
              disabled={battle.phase !== "question" || Boolean(battle.yourAnswer) || Boolean(pending)}
              onClick={() => onAnswer(choice.id)}
            >
              <b>{choice.id.toUpperCase()}</b>
              <span>{choice.text}</span>
            </button>
          );
        })}
      </div>
      {battle.reveal && <p className="explain">{battle.reveal.explanation}</p>}
    </article>
  );
}

function Qa({
  items,
  text,
  onText,
  onPost,
  onVote,
}: {
  items: PublicQa[];
  text: string;
  onText: (v: string) => void;
  onPost: () => void;
  onVote: (id: string) => void;
}) {
  return (
    <div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onPost(); }}>
        <label htmlFor="q">Ask the room</label>
        <input id="q" type="text" maxLength={200} value={text} onChange={(e) => onText(e.target.value)} placeholder="How does Lambda scale?" />
        <button className="btn primary tap" type="submit">Post question</button>
      </form>
      <div style={{ height: 12 }} />
      {items.length === 0 && <p className="waiting">No questions yet.</p>}
      {items.map((item) => (
        <article key={item.id} className="qa-card">
          <div className="row">
            <p style={{ margin: 0 }}>{item.text}</p>
            <button className={`vote tap ${item.voted ? "on" : ""}`} type="button" onClick={() => onVote(item.id)}>{item.upvotes}</button>
          </div>
          <p className="fine">{item.byName}{item.answered ? " · Answered" : ""}</p>
        </article>
      ))}
    </div>
  );
}

function Match({
  picks,
  group,
  onToggle,
  onSave,
}: {
  picks: string[];
  group: PublicGroup | null;
  onToggle: (interest: string) => void;
  onSave: () => void;
}) {
  return (
    <div>
      <p>Tick what you want to talk about. We will match you with 2 or 3 people in the room.</p>
      <div className="chips">
        {event.match.interests.map((interest) => (
          <button key={interest} className={`interest tap ${picks.includes(interest) ? "on" : ""}`} type="button" onClick={() => onToggle(interest)}>
            {interest}
          </button>
        ))}
      </div>
      <div className="stack">
        <button className="btn primary tap" type="button" onClick={onSave}>Find my group</button>
      </div>
      {group ? (
        <article className="match-card">
          <p className="kicker">Your group · {group.interest}</p>
          <h2 style={{ margin: 0 }}>{group.names.join(", ")}</h2>
          <p className="fine">Say hi about {group.interest}.</p>
        </article>
      ) : (
        <p className="waiting">Save your interests and we will pair you when someone overlaps.</p>
      )}
    </div>
  );
}

function Icon({ name }: { name: Tab }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };
  if (name === "battle") return <svg {...common}><path d="M5 19h14M7 16l5-12 5 12" /></svg>;
  if (name === "board") return <svg {...common}><rect x="4" y="4" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /><path d="M11 8h2v8h-2M8 11v2h8v-2" /></svg>;
  if (name === "qa") return <svg {...common}><path d="M5 6h14v9H8l-3 3V6z" /></svg>;
  return <svg {...common}><circle cx="8" cy="9" r="2" /><circle cx="16" cy="9" r="2" /><path d="M4 18c1-3 3-4 4-4s3 1 4 4M12 18c1-3 3-4 4-4s3 1 4 4" /></svg>;
}
