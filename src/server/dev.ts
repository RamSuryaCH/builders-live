// SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { startLocalServer } from "./local.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT ?? 8080);
const vite = await createVite({
  configFile: path.join(root, "vite.config.ts"),
  server: { middlewareMode: true },
  appType: "custom",
});
const indexHtml = await readFile(path.join(root, "frontend/index.html"), "utf8");

const running = await startLocalServer({
  port,
  host: "0.0.0.0",
  staticDir: null,
  onRequest: (req, res) =>
    new Promise((resolve) => {
      vite.middlewares(req, res, () => {
        vite
          .transformIndexHtml(req.url ?? "/", indexHtml)
          .then((html) => {
            if (!res.writableEnded) {
              res.setHeader("content-type", "text/html; charset=utf-8");
              res.end(html);
            }
            resolve(true);
          })
          .catch((err: unknown) => {
            res.statusCode = 500;
            res.end(err instanceof Error ? err.message : "render failed");
            resolve(true);
          });
      });
    }),
});

console.log(`Builders Live dev ${running.url}`);
