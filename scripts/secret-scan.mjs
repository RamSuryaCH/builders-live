import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const skip = new Set(["node_modules", "dist", "dist-lambda", "frontend/dist", ".git", ".aws-sam", "coverage"]);
const textExt = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".html", ".css", ".svg", ".txt", ".toml", ".sh", ".example"]);

const patterns = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { name: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "account-arn", re: /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/ },
];

const otherClouds = /\b(azure|gcp|google cloud|cloudflare|heroku|firebase|digitalocean)\b/i;

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (textExt.has(path.extname(entry.name)) || entry.name === "LICENSE" || entry.name === "LICENSE-CONTENT") out.push(full);
  }
  return out;
}

const files = (await walk(".")).filter((file) => file !== "scripts/secret-scan.mjs");
const findings = [];
for (const file of files) {
  if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
  const body = await readFile(file, "utf8");
  for (const pattern of patterns) {
    const match = body.match(pattern.re);
    if (match) findings.push(`${file}: ${pattern.name}: ${match[0]}`);
  }
  const cloud = body.match(otherClouds);
  if (cloud) findings.push(`${file}: other-cloud: ${cloud[0]}`);
}

if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log(`secret scan ok (${files.length} files)`);
