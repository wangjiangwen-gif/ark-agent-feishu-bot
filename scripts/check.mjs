import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// 沿用Node语法检查；自动覆盖新增模块，不将其误称为TypeScript类型检查。
for (const file of (await readdir("src", { recursive: true })).filter(path => path.endsWith(".ts")).sort()) {
  execFileSync(process.execPath, ["--experimental-strip-types", "--check", join("src", file)], { stdio: "inherit" });
}
