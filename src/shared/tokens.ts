// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface HostToken {
  r: "h";
  exp: number;
}

export interface PlayerToken {
  r: "p";
  exp: number;
  room: string;
  pid: string;
  did: string;
}

export type TokenPayload = HostToken | PlayerToken;

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function readToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = sign(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (!payload || typeof payload.exp !== "number" || payload.exp < now) return null;
    if (payload.r !== "h" && payload.r !== "p") return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashSecret(secret: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const hash = scryptSync(secret, s, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:${s.toString("hex")}:${hash.toString("hex")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = scryptSync(secret, Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, "hex");
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}
