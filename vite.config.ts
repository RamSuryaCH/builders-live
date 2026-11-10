import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

function publicBase(): Plugin {
  const base = (process.env.PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  return {
    name: "public-base-url",
    transformIndexHtml(html) {
      return html.replaceAll("__PUBLIC_BASE_URL__", base);
    },
  };
}

export default defineConfig({
  root: path.join(root, "frontend"),
  plugins: [react(), publicBase()],
  resolve: {
    alias: { "@shared": path.join(root, "src/shared") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2018",
  },
});
