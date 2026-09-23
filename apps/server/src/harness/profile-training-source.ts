import path from "node:path";

import { createHarnessPolicySourcePackage, createHarnessSourcePackage } from "@openpond/harness";

import { materializeHarnessSource } from "../training/materialize-harness-source.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";

/** Export only model-visible bytes from the exact selected Profile release.
 * The complete package is verified inside the app-server before redaction. */
export async function profileTrainingSource(input: {
  release: LocalHarnessReleaseRecord;
  storeDir: string;
}) {
  const { release } = input;
  const files = await materializeHarnessSource({
    sourcePath: path.join(release.bundlePath, "source"),
    storeDir: input.storeDir,
    harnessHash: release.harnessRelease.contentHash,
    files: release.harnessRelease.files,
  });
  const complete = createHarnessSourcePackage({
    agentSnapshot: release.agentSnapshot,
    harnessRelease: release.harnessRelease,
    files,
  });
  return createHarnessPolicySourcePackage(complete, {
    id: release.harnessRelease.id,
    contentHash: release.harnessRelease.contentHash,
  });
}
