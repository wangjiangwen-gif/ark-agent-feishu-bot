import { rm, readFile, readdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts", "src/core.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]"
});

const hash = createHash("sha256");
const sourceFiles = (await readdir("src", { recursive: true })).filter(path => path.endsWith(".ts")).sort();
const lockfile = (await readdir(".")).includes("package-lock.json") ? ["package-lock.json"] : [];
for (const file of ["package.json", ...lockfile, "scripts/build.mjs", ...sourceFiles.map(path => `src/${path}`)]) hash.update(file).update("\0").update(await readFile(file)).update("\0");
let commit, dirty;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
} catch { /* npm包中可能没有Git目录，sourceHash仍可用于核对 */ }
await writeFile("dist/build-info.json", JSON.stringify({ commit, dirty, sourceHash: hash.digest("hex") }) + "\n");
