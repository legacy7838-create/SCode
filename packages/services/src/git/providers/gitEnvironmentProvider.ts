import { spawn } from "node:child_process";
import {
  DEFAULT_GIT_DISCOVERY_TIMEOUT_MS,
  getGitBinaryCandidates,
  getGitCommandEnv,
} from "../config.js";

export interface GitEnvironmentProvider {
  resolveGitBinary(): Promise<string | null>;
  createCommandEnv(): NodeJS.ProcessEnv;
}

async function canExecuteGitCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function createGitEnvironmentProvider(): GitEnvironmentProvider {
  let cachedGitBinaryPromise: Promise<string | null> | null = null;

  return {
    async resolveGitBinary(): Promise<string | null> {
      if (cachedGitBinaryPromise) {
        return await cachedGitBinaryPromise;
      }

      const env = getGitCommandEnv();
      // Git binary's detection does not change frequently within a session,
      // The first detection result is cached here to avoid `git --version` being typed repeatedly for each Git RPC.
      cachedGitBinaryPromise = (async () => {
        for (const candidate of getGitBinaryCandidates()) {
          if (await canExecuteGitCandidate(candidate, env)) {
            return candidate;
          }
        }
        return null;
      })();

      return await cachedGitBinaryPromise;
    },

    createCommandEnv(): NodeJS.ProcessEnv {
      return getGitCommandEnv();
    },
  };
}
