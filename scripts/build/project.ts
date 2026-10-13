import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { withBuildLock } from "./build-lock.ts";
import { incrementalEmit } from "./incremental-emit.ts";
import { publishBuild, stageEmit } from "./publish.ts";

export async function buildProject(root: string): Promise<void> {
  await withBuildLock(path.join(root, "node_modules/.cache/build.lock"), async () => {
    const staging = path.join(root, "node_modules/.cache", `dist-${randomUUID()}`);
    const dist = path.join(root, "dist");
    await mkdir(staging, { recursive: true });
    try {
      await stageEmit(await incrementalEmit(root, true, "tsconfig.json"), staging, dist);
      await publishBuild(staging, dist);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
