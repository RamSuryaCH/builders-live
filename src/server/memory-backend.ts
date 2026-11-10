// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type { StoreBackend } from "./room-store.js";

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
  ): Promise<"ok" | "conflict" | "missing"> {
    const current = this.bucket(pk).get(sk);
    if (!current) {
      if (update.includes("ADD score")) {
        const next: Row = { pk, sk, score: Number(values[":p"] ?? 0), ttl: values[":ttl"] };
        this.bucket(pk).set(sk, next);
        return "ok";
      }
      return "missing";
    }
    if (condition && !evalCondition(current, condition, values)) return "conflict";
    const next = { ...current };
    if (update.includes("ADD score")) next.score = Number(next.score ?? 0) + Number(values[":p"] ?? 0);
    if (names?.["#ttl"] && values[":ttl"] != null) next.ttl = values[":ttl"];
    this.bucket(pk).set(sk, next);
    return "ok";
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
