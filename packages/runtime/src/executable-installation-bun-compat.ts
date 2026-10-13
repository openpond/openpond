import path from "node:path";

// Discover user-installed CLI launchers without using this runtime for OpenPond.
export function userCliBinPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(env.BUN_INSTALL || path.join(home, ".bun"), "bin");
}
