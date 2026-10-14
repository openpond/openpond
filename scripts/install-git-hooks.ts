import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

if (process.env.CI !== "1" && process.env.CI !== "true") {
  const insideWorktree = await run(["rev-parse", "--is-inside-work-tree"], true);
  if (insideWorktree === 0) {
    const existing = await run(["config", "--get", "core.hooksPath"], true);
    if (existing === 0) {
      console.log("Preserved existing Git hooks configuration.");
    } else if (existing === 1) {
      const configured = await run(["config", "core.hooksPath", ".githooks"]);
      if (configured !== 0) process.exit(configured);
      console.log("Configured Git hooks from .githooks.");
    } else {
      process.exit(existing);
    }
  }
}

async function run(args: string[], quiet = false): Promise<number> {
  const child = spawn("git", args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: quiet ? "ignore" : "inherit",
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return code ?? 1;
}
