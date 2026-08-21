import type {
  HarnessRunOverlay,
  HarnessWorkspace,
  RefinementTriggerDecision,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import { readBoundedRefinerSource } from "./local-harness-refiner-context.js";

export async function loadRefinerReleaseContext(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  trigger: RefinementTriggerDecision;
  rebasedOntoCurrent: boolean;
}) {
  const effectiveReleaseRef = input.rebasedOntoCurrent
    ? input.workspace.currentChannel.release
    : input.overlay.baseHarnessRelease;
  if (!effectiveReleaseRef) {
    throw new Error("Queued Refiner trigger references a Harness workspace without a current release.");
  }
  const release = await input.store.getHarnessReleaseRecord(
    effectiveReleaseRef.contentHash,
  );
  if (
    !release ||
    release.harnessRelease.id !== effectiveReleaseRef.id ||
    release.workspaceId !== input.workspace.id
  ) {
    throw new Error("Queued Refiner trigger references an unavailable effective Harness release.");
  }
  const source = await readBoundedRefinerSource(
    release.bundlePath,
    input.trigger,
    { forceUnloaded: input.rebasedOntoCurrent },
  );
  const admittedRelease = input.rebasedOntoCurrent
    ? await input.store.getHarnessReleaseRecord(
        input.overlay.baseHarnessRelease.contentHash,
      )
    : release;
  if (
    !admittedRelease ||
    admittedRelease.harnessRelease.id !== input.overlay.baseHarnessRelease.id ||
    admittedRelease.workspaceId !== input.workspace.id
  ) {
    throw new Error("Queued Refiner trigger references an unavailable admitted Harness release.");
  }
  const admittedSource = input.rebasedOntoCurrent
    ? await readBoundedRefinerSource(admittedRelease.bundlePath, input.trigger)
    : source;
  return { admittedSource, effectiveReleaseRef, release, source };
}
