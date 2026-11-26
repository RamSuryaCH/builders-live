// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type { StoreBackend, UpdateResult } from "./room-store.js";

type Row = Record<string, unknown>;

function evalCondition(item: Row | undefined, condition: string | undefined, values: Record<string, unknown> = {}): boolean {
  if (!condition) return true;
  if (condition.includes("attribute_not_exists(pk)")) return !item;
  if (condition.includes("attribute_not_exists(until)")) {
    if (!item) return true;
    if (condition.includes("OR until < :now")) return Number(item.until ?? 0) < Number(values[":now"] ?? 0);
    return false;
  }
  if (!item) return false;
  const parts = condition.split(" AND ").map((p) => p.trim());
  for (const part of parts) {
    const m = part.match(/^(\w+)\s*=\s*(:\w+)$/);
    if (!m) return false;
    if (item[m[1]] !== values[m[2]]) return false;
  }
  return true;
}

function attrName(token: string, names: Record<string, string> = {}): string {
  if (!token.startsWith("#")) return token;
  const resolved = names[token];
  if (!resolved) throw new Error(`missing attribute name for ${token}`);
  return resolved;
}

/**
 * Applies the ADD and SET clauses the room store uses to a copy of an item.
 * ADD treats a missing attribute as 0 and creates it. Any other clause throws,
 * so an unsupported update fails in tests instead of silently doing nothing.
 */
function applyUpdate(item: Row, expr: string, values: Row, names?: Record<string, string>): Row {
  const next: Row = { ...item };
  for (const part of expr.trim().split(/\s+(?=(?:ADD|SET)\s)/)) {
    const kind = part.slice(0, 3);
    const body = part.slice(3).trim();
    if (kind !== "ADD" && kind !== "SET") throw new Error(`unsupported update clause: ${part}`);
    for (const assignment of body.split(",")) {
      if (kind === "ADD") {
        const [attr, placeholder] = assignment.trim().split(/\s+/);
        const key = attrName(attr, names);
        next[key] = Number(next[key] ?? 0) + Number(values[placeholder]);
      } else {
        const [lhs, rhs] = assignment.split("=").map((s) => s.trim());
        next[attrName(lhs, names)] = values[rhs];
      }
    }
  }
  return next;
}

export class MemoryBackend implements StoreBackend {
  private data = new Map<string, Map<string, Row>>();

  private bucket(pk: string): Map<string, Row> {
    let map = this.data.get(pk);
    if (!map) {
      map = new Map();
      this.data.set(pk, map);
    }
    return map;
  }

  ttl(hours = Number(process.env.DATA_TTL_HOURS ?? 24)): number {
    return Math.floor(Date.now() / 1000) + hours * 3600;
  }

  async get(pk: string, sk: string): Promise<Row | null> {
    return this.bucket(pk).get(sk) ?? null;
  }

  async put(item: Row, condition?: string, values?: Record<string, unknown>): Promise<"ok" | "conflict"> {
    const pk = String(item.pk);
    const sk = String(item.sk);
    const current = this.bucket(pk).get(sk);
    if (!evalCondition(current, condition, values)) return "conflict";
    this.bucket(pk).set(sk, { ...item });
    return "ok";
  }

  async update(
    pk: string,
    sk: string,
    update: string,
    values: Record<string, unknown>,
    names?: Record<string, string>,
    condition?: string,
  ): Promise<UpdateResult> {
    const bucket = this.bucket(pk);
    const current = bucket.get(sk);
    if (condition && !evalCondition(current, condition, values)) return { status: "conflict", attrs: {} };
    const next = applyUpdate(current ?? { pk, sk }, update, values as Row, names);
    bucket.set(sk, next);
    return { status: "ok", attrs: { ...next } };
  }

  async query(pk: string, skPrefix: string): Promise<Row[]> {
    const out: Row[] = [];
    for (const [sk, item] of this.bucket(pk)) {
      if (!skPrefix || sk.startsWith(skPrefix)) out.push({ ...item });
    }
    return out;
  }

  async remove(pk: string, sk: string): Promise<void> {
    this.bucket(pk).delete(sk);
  }
}
