// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
// Light filter for display names and short text. Whole words only, so
// ordinary words that merely contain a fragment (classic, password, analytics)
// are left alone.

const WORDS = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "piss",
  "cunt",
  "slut",
  "whore",
  "nigger",
  "faggot",
  "retard",
];

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/\$/g, "s")
    .replace(/7/g, "t");
}

export function isProfane(input: string): boolean {
  const text = normalize(input);
  for (const word of WORDS) {
    const body = word.split("").join("[^a-z0-9]{0,3}");
    const re = new RegExp(`(^|[^a-z0-9])${body}([^a-z0-9]|$)`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

export function cleanName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.replace(/\s+/g, " ").replace(/[^\p{L}\p{N} .'’-]/gu, "").trim();
  if (name.length < 2) return { ok: false, message: "Use at least 2 characters." };
  if (name.length > 20) return { ok: false, message: "Keep your name to 20 characters." };
  if (isProfane(name)) return { ok: false, message: "Please pick a different display name." };
  return { ok: true, name };
}

export function assertCleanText(raw: string, max: number): { ok: true; text: string } | { ok: false; message: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, message: "Write a question first." };
  if (text.length > max) return { ok: false, message: `Keep it under ${max} characters.` };
  if (isProfane(text)) return { ok: false, message: "Please rephrase that." };
  return { ok: true, text };
}
