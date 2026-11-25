// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { useId, useState, type CSSProperties } from "react";
import { loadConfig } from "@shared/event-config";
import type { PublicSeat } from "@shared/protocol";
import type { RoomMapTableConfig } from "@shared/types";
import { tap } from "../haptics";

const roomMap = loadConfig().roomMap;

interface SeatInfo {
  table: RoomMapTableConfig;
  number: number;
}

const seatInfo = new Map<string, SeatInfo>();
for (const table of roomMap.tables) {
  table.seats.forEach((seat, index) => seatInfo.set(seat.id, { table, number: index + 1 }));
}

/** Case-insensitive name match used by the find-a-teammate field on every screen. */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length > 0 && name.toLowerCase().includes(q);
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

interface RoomMapProps {
  seats: PublicSeat[];
  /** The viewer's player id, used to highlight their own seat. */
  youId?: string | null;
  /** Players tap to sit. Screen and host views leave this off. */
  interactive?: boolean;
  onSit?: (seatId: string) => void;
  onLeave?: () => void;
  showFind?: boolean;
  /** Pass both to control the find field from the parent. Omit them to keep the query inside the map. */
  findValue?: string;
  onFindChange?: (value: string) => void;
  variant?: "play" | "host" | "screen";
}

export function RoomMap({
  seats,
  youId = null,
  interactive = false,
  onSit,
  onLeave,
  showFind = false,
  findValue,
  onFindChange,
  variant = "play",
}: RoomMapProps) {
  const id = useId();
  const [ownFind, setOwnFind] = useState("");
  const [demo, setDemo] = useState(false);
  const find = findValue ?? ownFind;
  const setFind = onFindChange ?? setOwnFind;
  const active = showFind && find.trim().length > 0;

  const bySeat = new Map(seats.map((s) => [s.seatId, s]));
  const matched = new Set(active ? seats.filter((s) => matchesQuery(s.name, find)).map((s) => s.playerId) : []);
  const matchCount = matched.size;
  const mine = youId ? seats.find((s) => s.playerId === youId) : undefined;
  const mineInfo = mine ? seatInfo.get(mine.seatId) : undefined;

  return (
    <section className={`room-map room-${variant}`} aria-label="Cafe room map">
      <div className="room-head">
        <p className="room-venue">{`${roomMap.venueName}, ${roomMap.city}`}</p>
        <div className="room-badges">
          <span className="room-badge">{roomMap.badge}</span>
          <span className="room-badge">{roomMap.selfReportedLabel}</span>
          {demo && <span className="room-badge demo">{roomMap.demoBadge}</span>}
        </div>
      </div>

      <div className="room-tools">
        {showFind && (
          <div className="room-find">
            <label htmlFor={`${id}-find`}>Find a teammate</label>
            <input
              id={`${id}-find`}
              type="text"
              value={find}
              maxLength={60}
              placeholder="Type a name"
              autoComplete="off"
              onChange={(e) => setFind(e.target.value)}
            />
          </div>
        )}
        <label className="check room-demo">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          Wi-Fi sensing demo
        </label>
      </div>

      {active && (
        <p className="find-note" role="status">
          {matchCount
            ? `${matchCount} ${matchCount === 1 ? "person matches" : "people match"} "${find.trim()}".`
            : `No one matches "${find.trim()}".`}
        </p>
      )}

      {interactive && (
        <div className="room-seat-row">
          {mineInfo ? (
            <>
              <p className="room-hint">You are at {mineInfo.table.label}.</p>
              <button className="btn ghost tap" type="button" onClick={() => onLeave?.()}>
                Leave seat
              </button>
            </>
          ) : (
            <p className="room-hint">Tap an open seat to sit down. Tap another open seat to move.</p>
          )}
        </div>
      )}

      <div className={`room-stage${matchCount ? " has-find" : ""}`}>
        <div className="room-window">Window</div>
        <div className="room-counter">Counter</div>
        <div className="room-floor">
          {roomMap.tables.map((table) => (
            <div key={table.id} className="room-table" style={{ left: `${table.x}%`, top: `${table.y}%` }}>
              <span>{table.label}</span>
            </div>
          ))}
          {roomMap.tables.flatMap((table) =>
            table.seats.map((seat, index) => {
              const sitter = bySeat.get(seat.id);
              return (
                <Seat
                  key={seat.id}
                  seatId={seat.id}
                  tableLabel={table.label}
                  seatNumber={index + 1}
                  left={`${table.x + seat.dx}%`}
                  top={`${table.y + seat.dy}%`}
                  sitter={sitter}
                  isYou={Boolean(sitter && youId && sitter.playerId === youId)}
                  isMatch={Boolean(sitter && matched.has(sitter.playerId))}
                  interactive={interactive}
                  demo={demo}
                  onSit={() => onSit?.(seat.id)}
                  onLeave={() => onLeave?.()}
                />
              );
            }),
          )}
        </div>
      </div>
    </section>
  );
}

interface SeatProps {
  seatId: string;
  tableLabel: string;
  seatNumber: number;
  left: string;
  top: string;
  sitter?: PublicSeat;
  isYou: boolean;
  isMatch: boolean;
  interactive: boolean;
  demo: boolean;
  onSit: () => void;
  onLeave: () => void;
}

function Seat({ seatId, tableLabel, seatNumber, left, top, sitter, isYou, isMatch, interactive, demo, onSit, onLeave }: SeatProps) {
  const where = `${tableLabel}, seat ${seatNumber}`;
  const classes = ["seat", sitter ? "taken" : "open", isYou ? "is-you" : "", isMatch ? "is-match" : ""].filter(Boolean).join(" ");
  // Simulated figures only ever appear on empty seats, and only in the client-side demo.
  const showDemo = demo && !sitter && hash(seatId) % 3 === 0;

  let control;
  if (sitter) {
    const figure = <Figure color={sitter.teamColor} />;
    if (isYou && interactive) {
      control = (
        <button className="seat-hit" type="button" aria-label={`Leave your seat at ${where}`} onClick={() => { tap(6); onLeave(); }}>
          {figure}
        </button>
      );
    } else {
      control = (
        <div className="seat-hit" role="img" aria-label={`${sitter.name}${isYou ? " (you)" : ""}, ${where}`}>
          {figure}
        </div>
      );
    }
  } else if (interactive) {
    control = (
      <button className="seat-hit" type="button" aria-label={`Sit at ${where}`} onClick={() => { tap(8); onSit(); }}>
        <span className="stool" />
      </button>
    );
  } else {
    control = (
      <div className="seat-hit" aria-hidden="true">
        <span className="stool" />
      </div>
    );
  }

  return (
    <div className={classes} style={{ left, top }}>
      {(isYou || isMatch) && <span className={`seat-ring ${isYou ? "you" : "match"}`} aria-hidden="true" />}
      {control}
      {sitter && <span className="seat-name">{isYou ? "You" : sitter.name}</span>}
      {showDemo && (
        <span className="demo-wrap" aria-hidden="true">
          <Figure demo delay={-(hash(seatId) % 40) / 10} />
        </span>
      )}
    </div>
  );
}

function Figure({ color, demo = false, delay = 0 }: { color?: string; demo?: boolean; delay?: number }) {
  const style = demo ? { ["--d" as string]: `${delay}s` } : { color };
  return (
    <svg className={demo ? "figure demo" : "figure"} style={style as CSSProperties} viewBox="0 0 24 34" width="24" height="34" aria-hidden="true" focusable="false">
      <g className="fig-body" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <circle className="fig-head" cx="12" cy="5.5" r="4.2" fill="currentColor" />
        <line x1="12" y1="10.5" x2="12" y2="21" />
        <line className="fig-arm-l" x1="12" y1="14" x2="6.5" y2="20" />
        <line className="fig-arm-r" x1="12" y1="14" x2="17.5" y2="20" />
        <line className="fig-leg-l" x1="12" y1="21" x2="7.5" y2="31.5" />
        <line className="fig-leg-r" x1="12" y1="21" x2="16.5" y2="31.5" />
      </g>
    </svg>
  );
}
