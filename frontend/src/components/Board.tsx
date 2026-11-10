import { useRef, useState, type PointerEvent } from "react";
import type { PublicBoard, PublicCursor } from "@shared/protocol";
import { loadConfig } from "@shared/event-config";
import { tap } from "../haptics";

const event = loadConfig();
const tileLabel = new Map(event.board.tiles.map((t) => [t.id, t]));

function point(e: PointerEvent, el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return {
    x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)),
    y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)),
  };
}

export function BoardView({
  board,
  cursors = [],
  editable,
  onPlace,
  onMove,
  onCursor,
  onConnect,
  onDelete,
}: {
  board: PublicBoard;
  cursors?: PublicCursor[];
  editable: boolean;
  onPlace?: (tile: string, x: number, y: number) => void;
  onMove?: (id: string, x: number, y: number) => void;
  onCursor?: (x: number, y: number) => void;
  onConnect?: (from: string, to: string) => void;
  onDelete?: (id: string) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const lastMove = useRef(0);
  const lastCursor = useRef(0);
  const nodes = board.nodes.map((n) => (drag && drag.id === n.id ? { ...n, x: drag.x, y: drag.y } : n));

  return (
    <div>
      {board.challenge && <div className="challenge">{board.challenge}</div>}
      {board.locked && <p className="fine">The host locked the board.</p>}
      {editable && (
        <>
          <div className="palette">
            {event.board.tiles.map((tile) => (
              <button
                key={tile.id}
                className="tile tap"
                type="button"
                onClick={() => {
                  if (board.locked) return;
                  tap(8);
                  onPlace?.(tile.id, 12 + Math.random() * 70, 16 + Math.random() * 60);
                }}
              >
                {tile.label}
                <small>{tile.group}</small>
              </button>
            ))}
          </div>
          <div className="tools">
            <button className={`btn ghost tap ${connect ? "primary" : ""}`} type="button" onClick={() => setConnect((v) => !v)}>
              {connect ? "Connecting…" : "Connect"}
            </button>
            <button className="btn ghost tap" type="button" disabled={!selected} onClick={() => selected && onDelete?.(selected)}>
              Remove
            </button>
          </div>
        </>
      )}
      <div
        className="board-wrap"
        ref={canvas}
        onPointerMove={(e) => {
          if (!canvas.current) return;
          const p = point(e, canvas.current);
          const t = Date.now();
          if (t - lastCursor.current > 140) {
            lastCursor.current = t;
            onCursor?.(p.x, p.y);
          }
          if (drag) {
            setDrag({ ...drag, ...p });
            if (t - lastMove.current > 140) {
              lastMove.current = t;
              onMove?.(drag.id, p.x, p.y);
            }
          }
        }}
        onPointerUp={() => setDrag(null)}
      >
        <svg className="edges" viewBox="0 0 100 100" preserveAspectRatio="none">
          {board.edges.map((edge) => {
            const a = nodes.find((n) => n.id === edge.from);
            const b = nodes.find((n) => n.id === edge.to);
            if (!a || !b) return null;
            return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
        </svg>
        {nodes.map((node) => {
          const meta = tileLabel.get(node.tileType);
          return (
            <button
              key={node.id}
              className={`node tap ${selected === node.id ? "on" : ""}`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
              type="button"
              onPointerDown={(e) => {
                if (!editable || board.locked) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag({ id: node.id, x: node.x, y: node.y });
                setSelected(node.id);
              }}
              onClick={() => {
                if (!editable) return;
                if (connect && selected && selected !== node.id) {
                  onConnect?.(selected, node.id);
                  setConnect(false);
                }
                setSelected(node.id);
                tap(6);
              }}
            >
              {meta?.label ?? node.tileType}
              <small>{node.byName}</small>
            </button>
          );
        })}
        {cursors.map((c) => (
          <div key={c.playerId} className="cursor" style={{ left: `${c.x}%`, top: `${c.y}%`, color: c.color }}>
            <i style={{ background: c.color }} />
            {c.name}
          </div>
        ))}
      </div>
    </div>
  );
}
