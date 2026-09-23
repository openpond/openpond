import { promises as fs } from "node:fs";
import path from "node:path";

import type { OpenPondProfileRef } from "@openpond/contracts";
import { loadReleasedProfileEvaluationCatalogAssets } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import { loadSelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";

/** Discover only verifier-private definitions from the exact Profile release
 * already selected by the caller. This never adopts a different workspace. */
export async function profileEvaluationsForRelease(input: {
  store: SqliteStore;
  ref: OpenPondProfileRef;
  sourceRevision: string;
  harnessRelease: { id: string; contentHash: string };
}) {
  const runtime = await loadSelectedLocalHarnessRuntime(input.store, input.harnessRelease);
  if (!runtime) throw new Error("Profile evaluation Harness release is unavailable.");
  const release = runtime.release.harnessRelease;
  const provenance = release.metadata.profile;
  if (!provenance || typeof provenance !== "object"
    || (provenance as Record<string, unknown>).id !== input.ref.profileId
    || (provenance as Record<string, unknown>).sourceRevision !== input.sourceRevision) {
    throw new Error("Profile evaluation release differs from its accepted source.");
  }
  const base = { profileRef: input.ref, sourceRevision: input.sourceRevision, harnessRelease: input.harnessRelease };
  if (!release.files.some((file) => file.path === "evals/catalog.json")) {
    return { ...base, catalogHash: null, definitions: [], suites: [] };
  }
  const sourceRoot = path.join(runtime.release.bundlePath, "source");
  const read = async (assetPath: string) => release.files.some((file) => file.path === assetPath)
    ? fs.readFile(path.join(sourceRoot, ...assetPath.split("/"))) : undefined;
  const [catalogBytes, workflowBytes, actionBytes] = await Promise.all([
    read("evals/catalog.json"), read("workflows/catalog.json"), read("workflows/actions.json"),
  ]);
  const { catalog, catalogHash } = loadReleasedProfileEvaluationCatalogAssets({
    agentSnapshot: runtime.release.agentSnapshot,
    harnessRelease: release,
    catalogBytes, workflowBytes, actionBytes,
  });
  return { ...base, catalogHash, definitions: catalog.definitions, suites: catalog.suites };
}
