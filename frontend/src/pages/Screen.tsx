import { useEffect, useRef, useState } from "react";
import { battleLabels } from "@shared/labels";
import type { LobbyView, PublicBattle, PublicBoard, PublicCursor, PublicGroup, PublicQa, ScreenView, ServerMessage, Standings } from "@shared/protocol";
import { BoardView } from "../components/Board";
import { Qr } from "../components/Qr";
import { Ring, useNow } from "../components/Ring";
import { LiveSocket, wsUrl } from "../net";

export function Screen({ code, eventName }: { code: string; eventName: string }) {
  const [view, setView] = useState<ScreenView | null>(null);
  const [offset, setOffset] = useState(0);
  const now = useNow();
  const sock = useRef<LiveSocket | null>(null);

  useEffect(() => {
    const live = new LiveSocket(wsUrl(), {
      onOpen: (send) => send({ type: "screen.join", roomCode: code, clientTs: Date.now() }),
      onMessage: (msg: ServerMessage) => {
        if ("serverTs" in msg && typeof msg.serverTs === "number") setOffset(msg.serverTs - Date.now());
        if (msg.type === "state" && msg.role === "screen") setView(msg.state as ScreenView);
        else if (msg.type === "battle") setView((v) => (v ? { ...v, battle: msg.battle, standings: msg.standings, screenMode: msg.screenMode } : v));
        else if (msg.type === "mode") setView((v) => (v ? { ...v, screenMode: msg.screenMode } : v));
        else if (msg.type === "standings") setView((v) => (v ? { ...v, standings: msg.standings } : v));
        else if (msg.type === "lobby") setView((v) => (v ? { ...v, lobby: msg.lobby, joined: msg.lobby.joined } : v));
        else if (msg.type === "board") setView((v) => (v ? { ...v, board: msg.board } : v));
        else if (msg.type === "cursors") setView((v) => (v ? { ...v, cursors: msg.cursors } : v));
        else if (msg.type === "qa") setView((v) => (v ? { ...v, qa: msg.items } : v));
        else if (msg.type === "match" && msg.groups) setView((v) => (v ? { ...v, groups: msg.groups ?? [] } : v));
      },
    });
    sock.current = live;
    live.start();
    const beat = window.setInterval(() => live.send({ type: "ping", clientTs: Date.now() }, true), 15000);
    return () => {
      window.clearInterval(beat);
      live.stop();
    };
  }, [code]);

  const joinUrl = `${location.origin}/join/${code}`;
  const synced = now + offset;
  if (!view) {
    return (
      <main className="screen">
        <p className="kicker">{eventName}</p>
        <h1>Waiting for room {code}</h1>
      </main>
    );
  }

  return (
    <main className="screen">
      {view.screenMode === "lobby" && <Lobby eventName={eventName} code={code} joinUrl={joinUrl} lobby={view.lobby} />}
      {view.screenMode === "battle" && <BattleWall battle={view.battle} standings={view.standings} now={synced} />}
      {view.screenMode === "board" && <BoardWall board={view.board} cursors={view.cursors} />}
      {view.screenMode === "qa" && <QaWall items={view.qa} />}
      {view.screenMode === "match" && <MatchWall groups={view.groups} />}
    </main>
  );
}

function Lobby({ eventName, code, joinUrl, lobby }: { eventName: string; code: string; joinUrl: string; lobby: LobbyView }) {
  return (
    <div className="lobby-layout">
      <div>
        <p className="kicker">{eventName}</p>
        <h1>Teams are filling</h1>
        <p className="joined-count">{lobby.joined}<span>joined{lobby.locked ? " · room locked" : ""}</span></p>
        <div className="team-grid">
          {lobby.teams.map((team) => (
            <section key={team.id} className="team-col" style={{ ["--team" as string]: team.color }}>
              <header><span><i /> {team.name}</span><span>{team.members.length}</span></header>
              {team.members.map((member, index) => (
                <span key={member.id} className="chip" style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}>
                  <span className="avatar" style={{ background: team.color }}>{member.initials}</span>
                  {member.name}
                </span>
              ))}
            </section>
          ))}
        </div>
      </div>
      <aside className="lobby-qr">
        <Qr text={joinUrl} alt={`QR code to join room ${code}`} />
        <p className="room-code">{code}</p>
        <p>Scan to join</p>
        <p className="fine">{joinUrl.replace(/^https?:\/\//, "")}</p>
      </aside>
    </div>
  );
}

function BattleWall({ battle, standings, now }: { battle: PublicBattle; standings: Standings; now: number }) {
  const remaining = battle.phase === "paused" ? battle.pausedRemainingMs ?? 0 : battle.endsAt ? Math.max(0, battle.endsAt - now) : 0;
  const max = Math.max(1, ...standings.teams.map((t) => t.score));
  const labels = battleLabels(battle);
  const showQuestionLine = Boolean(battle.question);
  return (
    <div className="battle-layout">
      <div>
        <p className="kicker">{battle.round > 0 ? labels.round : "Team Battle"}</p>
        {showQuestionLine && <p className="subkicker">{labels.question}</p>}
        {battle.phase === "intro" && <h1>{battle.roundIntro || battle.roundTitle}</h1>}
        {(battle.phase === "question" || battle.phase === "paused") && battle.question && <h1>{battle.question.prompt}</h1>}
        {battle.phase === "paused" && <p className="kicker">Paused</p>}
        {battle.phase === "reveal" && battle.reveal && (
          <div className="reveal-card">
            <p className="kicker">Answer</p>
            <h2 style={{ marginTop: 0 }}>{battle.question?.choices.find((c) => c.id === battle.reveal?.correctId)?.text}</h2>
            <p>{battle.reveal.explanation}</p>
          </div>
        )}
        {battle.phase === "break" && <h1>{battle.roundTitle} is in. Next round is next.</h1>}
        {battle.phase === "finished" && <h1>Final standings</h1>}
        {battle.phase === "idle" && <h1>Team Battle starts soon</h1>}
        {(battle.phase === "question" || battle.phase === "intro" || battle.phase === "paused") && (
          <Ring remainingMs={remaining} totalMs={battle.durationMs} light />
        )}
        <div className="toppers">
          {standings.topPlayers.map((p, i) => (
            <span key={p.id}>{i + 1}. {p.name} · {p.score}</span>
          ))}
        </div>
      </div>
      <div className="race" style={{ height: standings.teams.length * 72 }}>
        {standings.teams.map((team, index) => (
          <div key={team.id} className="race-row" style={{ transform: `translateY(${index * 72}px)` }}>
            <strong>{team.name}</strong>
            <div className="bar-track"><div className="bar" style={{ width: `${(team.score / max) * 100}%`, background: team.color }} /></div>
            <div className="race-score">{team.score}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardWall({ board, cursors }: { board: PublicBoard; cursors: PublicCursor[] }) {
  return (
    <div>
      <p className="kicker">Build Board</p>
      <h1 style={{ fontSize: "2.4rem" }}>{board.challenge ?? "Build it together"}</h1>
      <BoardView board={board} cursors={cursors} editable={false} />
    </div>
  );
}

function QaWall({ items }: { items: PublicQa[] }) {
  return (
    <div>
      <p className="kicker">Live Q&A</p>
      <h1>Top questions</h1>
      <div className="qa-wall">
        {items.filter((q) => !q.hidden).map((item) => (
          <article key={item.id}>
            <div>
              <strong>{item.text}</strong>
              <p className="fine">{item.byName}{item.answered ? " · Answered" : ""}</p>
            </div>
            <b>{item.upvotes}</b>
          </article>
        ))}
        {items.length === 0 && <p>No questions yet. Ask from your phone.</p>}
      </div>
    </div>
  );
}

function MatchWall({ groups }: { groups: PublicGroup[] }) {
  return (
    <div>
      <p className="kicker">Builder Match</p>
      <h1>Go say hi</h1>
      <div className="group-grid">
        {groups.map((group) => (
          <article key={group.id}>
            <p className="kicker">{group.interest}</p>
            <strong>{group.names.join(" · ")}</strong>
          </article>
        ))}
        {groups.length === 0 && <p>Groups appear as people tick interests.</p>}
      </div>
    </div>
  );
}
