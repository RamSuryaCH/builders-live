// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import type { Bucket } from "./types.js";

export function take(bucket: Bucket, now: number, limit: number, windowMs: number): boolean {
  if (now - bucket.t >= windowMs) {
    bucket.t = now;
    bucket.n = 0;
  }
  if (bucket.n >= limit) return false;
  bucket.n += 1;
  return true;
}

export interface AttemptRow {
  fails: number;
  windowStart: number;
  lockUntil: number;
}

export class LoginThrottle {
  private rows = new Map<string, AttemptRow>();

  constructor(
    private maxFails: number,
    private windowMs: number,
    private lockMs: number,
  ) {}

  /** True when this key is allowed to try. */
  allowed(key: string, now: number): boolean {
    const row = this.rows.get(key);
    return !row || row.lockUntil <= now;
  }

  fail(key: string, now: number): void {
    let row = this.rows.get(key);
    if (!row || now - row.windowStart > this.windowMs) {
      row = { fails: 0, windowStart: now, lockUntil: 0 };
    }
    row.fails += 1;
    if (row.fails >= this.maxFails) row.lockUntil = now + this.lockMs;
    this.rows.set(key, row);
  }

  success(key: string): void {
    this.rows.delete(key);
  }
}
