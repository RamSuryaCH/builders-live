import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const entries = ["ws", "timer", "bedrock", "secret-init"];
await mkdir("dist-lambda", { recursive: true });
for (const name of entries) {
  await build({
    entryPoints: [`src/server/${name}.ts`],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: `dist-lambda/${name}/handler.js`,
    legalComments: "none",
  });
}
console.log("bundled lambdas");
