import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ArkagentPaths {
  stateDir: string;
  configPath: string;
  databasePath: string;
}

export function getArkagentPaths(env: NodeJS.ProcessEnv = process.env): ArkagentPaths {
  const stateDir = resolve(env.ARKAGENT_HOME || join(homedir(), ".arkagent"));
  return {
    stateDir,
    configPath: join(stateDir, "config.env"),
    databasePath: join(stateDir, "gateway.db")
  };
}
