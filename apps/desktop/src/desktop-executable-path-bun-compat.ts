import path from "node:path";

// Recognize user-installed CLI shims without using Bun as an OpenPond runtime.
export function userBunBinPath(home: string, environment: NodeJS.ProcessEnv): string {
  return path.join(environment.BUN_INSTALL || path.join(home, ".bun"), "bin");
}
