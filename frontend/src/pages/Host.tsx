import { useEffect, useRef, useState } from "react";
import { loadConfig } from "@shared/event-config";
import type { AdminView, ScreenMode, ServerMessage } from "@shared/protocol";
import { Qr } from "../components/Qr";
import { go, tap } from "../haptics";
import { LiveSocket, wsUrl } from "../net";

const event = loadConfig();
const modes: { id: ScreenMode; label: string }[] = [
  { id: "lobby", label: "Lobby" },
  { id: "battle", label: "Team Battle" },
  { id: "board", label: "Build Board" },
  { id: "qa", label: "Live Q&A" },
  { id: "match", label: "Builder Match" },
];

export function Host({ eventName }: { eventName: string }) {
  const [pin, setPin] = useState("");
  const [token, setToken] = useState(() => sessionStorage.getItem("bl.host") ?? "");
  const [room, setRoom] = useState(() => sessionStorage.getItem("bl.room") ?? "");
  const [admin, setAdmin] = useState<AdminView | null>(null);
  const [error, setError] = useState("");
  const [block, setBlock] = useState(true);
  const [challenge, setChallenge] = useState(event.board.challenges[0]?.id ?? "");
  const [existing, setExisting] = useState("");
  const [status, setStatus] = useState("connecting");
  const sock = useRef<LiveSocket | null>(null);
  const tokenRef = useRef(token);
  const roomRef = useRef(room);
  tokenRef.current = token;
  roomRef.current = room;

  useEffect(() => {
    if (!token) return;
    const live = new LiveSocket(wsUrl(), {
      onStatus: setStatus,
      onOpen: (send) => {
        if (tokenRef.current && roomRef.current) {
          send({ type: "host.attach", token: tokenRef.current, roomCode: roomRef.current, clientTs: Date.now() });
        }
      },
      onMessage: (msg: ServerMessage) => {
        if (msg.type === "host.welcome") {
          sessionStorage.setItem("bl.host", msg.token);
          setToken(msg.token);
          setError("");
        } else if (msg.type === "room.created") {
          sessionStorage.setItem("bl.room", msg.roomCode);
          setRoom(msg.roomCode);
        } else if (msg.type === "state" && msg.role === "host") {
          setAdmin(msg.state as AdminView);
        } else if (msg.type === "admin") {
          setAdmin(msg.admin);
        } else if (msg.type === "error") {
          setError(msg.message);
          if (msg.code === "unauthorized") {
            sessionStorage.removeItem("bl.host");
            setToken("");
          }
        }
      },
    });
    sock.current = live;
    live.start();
    return () => live.stop();
  }, [token]);

  function send(msg: Parameters<LiveSocket["send"]>[0]) {
    sock.current?.send(msg);
  }

  if (!token) {
    return (
      <main className="host-login">
        <section className="card">
          <div className="brand-mark"><i /> {eventName}</div>
          <h1>Host console</h1>
          <p className="lede">Enter the host PIN set when this room was deployed.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              tap();
              const live = new LiveSocket(wsUrl(), {
                onOpen: (send) => send({ type: "host.login", secret: pin, clientTs: Date.now() }),
                onMessage: (msg) => {
                  if (msg.type === "host.welcome") {
                    sessionStorage.setItem("bl.host", msg.token);
                    setToken(msg.token);
                    live.stop();
                  } else if (msg.type === "error") {
                    setError(msg.message);
                    live.stop();
                  }
                },
              });
              live.start();
            }}
          >
            <label htmlFor="pin">Host PIN</label>
            <input id="pin" type="password" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} />
            <button className="btn primary full tap" type="submit">Enter</button>
            {error && <p className="fine">{error}</p>}
          </form>
        </section>
      </main>
    );
  }

  const joinUrl = room ? `${location.origin}/join/${room}` : "";
  return (
    <main className="host">
      {status !== "live" && <div className="banner">{status === "connecting" ? "Connecting…" : "Reconnecting…"}</div>}
      <header className="host-top">
        <div>
          <div className="brand-mark"><i /> {eventName}</div>
          <h1 style={{ fontSize: "2rem" }}>Host console</h1>
        </div>
        <button className="btn ghost tap" type="button" onClick={() => { sessionStorage.clear(); setToken(""); setAdmin(null); }}>Sign out</button>
      </header>
      {error && <p className="toast">{error}</p>}
      {!room && (
        <div className="stack" style={{ maxWidth: 420 }}>
          <button
            className="btn primary tap"
            type="button"
            onClick={() => {
              tap();
              send({ type: "host.createRoom", token, clientTs: Date.now() });
            }}
          >
            Create room
          </button>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const code = existing.toUpperCase().replace(/[^A-Z0-9]/g, "");
              if (code.length < 4) return;
              tap();
              sessionStorage.setItem("bl.room", code);
              setRoom(code);
              send({ type: "host.attach", token, roomCode: code, clientTs: Date.now() });
            }}
          >
            <label htmlFor="existing">Or open a room</label>
            <input id="existing" className="code-input" value={existing} onChange={(e) => setExisting(e.target.value)} placeholder="AB23CD" />
            <button className="btn ghost tap" type="submit">Open room</button>
          </form>
        </div>
      )}
      {room && (
        <div className="host-grid two" style={{ marginTop: 16 }}>
          <div className="host-grid">
            <section className="host-card qr-box">
              <Qr text={joinUrl} alt={`QR code for room ${room}`} />
              <p className="room-code">{room}</p>
              <p className="fine">{joinUrl}</p>
              <button className="btn primary tap" type="button" onClick={() => go(`/screen/${room}`)}>Open projector</button>
              <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.lock", token, locked: !admin?.locked, clientTs: Date.now() })}>
                {admin?.locked ? "Unlock room" : "Lock room"}
              </button>
            </section>
            <section className="host-card">
              <h2>Projector</h2>
              <div className="modes">
                {modes.map((mode) => (
                  <button key={mode.id} className={`btn ghost tap ${admin?.screenMode === mode.id ? "on" : ""}`} type="button" onClick={() => { tap(8); send({ type: "host.mode", token, mode: mode.id, clientTs: Date.now() }); }}>
                    {mode.label}
                  </button>
                ))}
              </div>
            </section>
            <section className="host-card">
              <h2>Team Battle</h2>
              <div className="controls">
                <button className="btn primary tap" type="button" onClick={() => send({ type: "host.start", token, clientTs: Date.now() })}>Start</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.pause", token, clientTs: Date.now() })}>Pause</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.resume", token, clientTs: Date.now() })}>Resume</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.skip", token, clientTs: Date.now() })}>Skip question</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.skipRound", token, clientTs: Date.now() })}>Skip round</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.stop", token, clientTs: Date.now() })}>Stop</button>
                <button className="btn danger tap" type="button" onClick={() => send({ type: "host.reset", token, clientTs: Date.now() })}>Reset</button>
              </div>
              <p className="fine">{admin ? phaseLabel(admin) : "Create a room, then start when the teams look full."}</p>
            </section>
            <section className="host-card">
              <h2>Build Board</h2>
              <label htmlFor="challenge">Challenge</label>
              <select id="challenge" value={challenge} onChange={(e) => setChallenge(e.target.value)} style={{ minHeight: 48, width: "100%", borderRadius: 12, margin: "6px 0 10px" }}>
                {event.board.challenges.map((item) => <option key={item.id} value={item.id}>{item.text}</option>)}
              </select>
              <div className="controls">
                <button className="btn primary tap" type="button" onClick={() => send({ type: "host.board.challenge", token, challengeId: challenge, clientTs: Date.now() })}>Set challenge</button>
                <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.board.lock", token, locked: !admin?.board.locked, clientTs: Date.now() })}>{admin?.board.locked ? "Unlock board" : "Lock board"}</button>
                <button className="btn danger tap" type="button" onClick={() => send({ type: "host.board.clear", token, clientTs: Date.now() })}>Clear board</button>
              </div>
            </section>
          </div>
          <div className="host-grid">
            <section className="stats">
              <div className="stat"><b>{admin?.counts.active ?? 0}</b><span>Active</span></div>
              <div className="stat"><b>{admin?.counts.idle ?? 0}</b><span>Idle</span></div>
              <div className="stat"><b>{admin?.counts.disconnected ?? 0}</b><span>Disconnected</span></div>
            </section>
            <section className="host-card">
              <h2>Teams</h2>
              {admin?.teams.map((team) => (
                <div key={team.id} className="player">
                  <div><span className="dot active" style={{ background: team.color }} />{team.name} · {team.members}</div>
                  <div>{team.score} · {Math.round(team.accuracy * 100)}%</div>
                </div>
              ))}
            </section>
            <section className="host-card">
              <h2>Players</h2>
              <label className="check"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Block rejoining</label>
              {admin?.players.filter((p) => !p.kicked).map((player) => (
                <div key={player.id} className="player">
                  <div>
                    <span className={`dot ${player.status}`} />
                    <strong>{player.name}</strong>
                    <div className="acc">{player.score} pts · {player.correct}/{player.answered} correct · {player.currentAnswered ? "answered this one" : "waiting"}</div>
                  </div>
                  <button className="btn danger tap" type="button" onClick={() => send({ type: "host.kick", token, playerId: player.id, block, clientTs: Date.now() })}>Kick</button>
                </div>
              ))}
            </section>
            <section className="host-card">
              <h2>Questions</h2>
              {admin?.questions.filter((q) => q.answered > 0 || q.round === admin.battle.round).map((q) => (
                <div key={q.id} className="qstat">
                  <div>{q.prompt}</div>
                  <div className="acc">{q.correct}/{q.answered} · {Math.round(q.accuracy * 100)}%</div>
                </div>
              ))}
            </section>
            <section className="host-card">
              <h2>Live Q&A</h2>
              {admin?.qa.map((item) => (
                <div key={item.id} className="player">
                  <div>
                    <strong>{item.text}</strong>
                    <div className="acc">{item.upvotes} votes{item.answered ? " · answered" : ""}{item.hidden ? " · hidden" : ""}</div>
                  </div>
                  <div className="controls">
                    <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.qa.answered", token, questionId: item.id, answered: !item.answered, clientTs: Date.now() })}>{item.answered ? "Reopen" : "Mark answered"}</button>
                    <button className="btn ghost tap" type="button" onClick={() => send({ type: "host.qa.hide", token, questionId: item.id, hidden: !item.hidden, clientTs: Date.now() })}>{item.hidden ? "Show" : "Hide"}</button>
                  </div>
                </div>
              ))}
              {admin?.features.bedrockSummary && (
                <button className="btn primary tap" type="button" onClick={() => send({ type: "host.summarise", token, clientTs: Date.now() })}>Summarise top questions</button>
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

function phaseLabel(admin: AdminView): string {
  const b = admin.battle;
  if (b.phase === "idle") return "Lobby is up. Start when you are ready.";
  if (b.phase === "intro") return `Story: ${b.roundTitle}`;
  if (b.phase === "question") return `Round ${b.round}, question ${b.questionIndex + 1}`;
  if (b.phase === "reveal") return "Showing the answer";
  if (b.phase === "paused") return "Paused";
  if (b.phase === "break") return "Between rounds";
  return "Finished";
}
