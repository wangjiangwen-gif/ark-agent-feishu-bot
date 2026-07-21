import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]"
});
