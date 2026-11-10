import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const og = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0c1726"/>
  <rect width="18" height="630" fill="#ff9900"/>
  <text x="88" y="250" fill="#f7f4ef" font-family="Inter, DejaVu Sans, sans-serif" font-size="92" font-weight="700">Builders Live</text>
  <text x="88" y="330" fill="#ff9900" font-family="Inter, DejaVu Sans, sans-serif" font-size="36" font-weight="600">Team Battle  ·  Build Board  ·  Live Q&amp;A  ·  Builder Match</text>
  <text x="88" y="400" fill="#c9d3df" font-family="Inter, DejaVu Sans, sans-serif" font-size="28">A live room for AWS meetups. Join from the phone in your hand.</text>
  <g transform="translate(88 470)">
    <rect x="0" y="18" width="280" height="22" rx="11" fill="#ff9900"/>
    <rect x="300" y="28" width="210" height="22" rx="11" fill="#3daa6d"/>
    <rect x="530" y="8" width="250" height="22" rx="11" fill="#4c6fff"/>
    <rect x="800" y="24" width="180" height="22" rx="11" fill="#9b6bff"/>
    <rect x="0" y="64" width="190" height="22" rx="11" fill="#e85d4c"/>
    <rect x="210" y="56" width="240" height="22" rx="11" fill="#f2c14e"/>
    <rect x="470" y="70" width="160" height="22" rx="11" fill="#2bb0c4"/>
    <rect x="650" y="52" width="220" height="22" rx="11" fill="#e56bb5"/>
  </g>
</svg>`;

await writeFile("frontend/public/og.svg", og);
await sharp(Buffer.from(og)).png().toFile("frontend/public/og.png");

const icon = await readFile("frontend/public/favicon.svg");
await sharp(icon).resize(32, 32).png().toFile("frontend/public/favicon-32.png");
await sharp(icon).resize(180, 180).png().toFile("frontend/public/apple-touch-icon.png");
await sharp(icon).resize(192, 192).png().toFile("frontend/public/icon-192.png");
await sharp(icon).resize(512, 512).png().toFile("frontend/public/icon-512.png");
console.log("brand images written");
