import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ChatContextTargetSchema } from "@openpond/contracts";
import {
  CreateSessionResourceDraftRequestSchema,
  SessionResourceDraftSchema,
  type CreateSessionRequest,
} from "@openpond/contracts/requests";
import { ModelProjectTrainingSetupSchema } from "openpond-sdk/model-projects";
import { parseAndVerifySavedModelVersionRead, type ExperimentDraft } from "openpond-sdk/training";
import { ownsHostedBenchmarkVersion, type BenchmarkModelVersion } from "@openpond/contracts/resource-setup";
import type { Session } from "@openpond/contracts/sessions";
import type { SqliteStore } from "../store/store.js";
import type { ReservedSessionCreation } from "../store/session-store.js";
import { chatExperimentContext, createChatExperimentScopes } from "./chat-experiment-scope.js";
import { requireHostedBenchmarkAccess, type HostedBenchmarkAccess } from "./hosted-benchmark-access.js";

const titles = {
  model: "New model",
  benchmark: "New benchmark",
  dataset: "New dataset",
  grader: "New grader",
} as const;

export function createSessionResourceDraft(input: {
  storeDir: string;
  store: SqliteStore;
  createReservedSession: (payload: unknown, reservation: ReservedSessionCreation) => Promise<Session>;
  access?: HostedBenchmarkAccess;
  readHostedVersion?: (source: Extract<BenchmarkModelVersion, { location: "cloud" }>) => Promise<unknown>;
}) {
  const benchmarkScopes = createChatExperimentScopes(input.store);
  return async (raw: unknown) => {
    const request = CreateSessionResourceDraftRequestSchema.parse(raw);
    const operation = `resource-draft-${request.operationId}`;
    const payloadHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const sessionId = operation;
    const reservation = { sessionId, operationId: operation, payloadHash };
    const resource = SessionResourceDraftSchema.parse({
      kind: request.kind,
      id: request.operationId,
      profileId: request.profileId,
      benchmarkVersion: request.benchmarkVersion,
    });
    const current = resource.kind === "benchmark" ? await input.store.getSession(sessionId) : null;
    const initialized = current && chatExperimentContext(current.metadata).scopes.some(scope => scope.draft?.id === resource.id);
    let startingModel: ExperimentDraft["startingModel"];
    const source = resource.benchmarkVersion;
    if (source?.location === "cloud") {
      if (!input.access) throw new Error("Saved Model versions are unavailable.");
      const pin = SessionResourceDraftSchema.safeParse(current?.metadata?.resourceDraft).data?.benchmarkVersion;
      const saved = pin?.location === "cloud" ? pin : undefined;
      const access = await requireHostedBenchmarkAccess(saved ?? source, input.access);
      if (source.teamId !== access.teamId || source.owner && !ownsHostedBenchmarkVersion(source, {
        teamId: access.teamId, ...access.owner,
      })) throw new Error("The active account changed. Reopen the saved Model version.");
      resource.benchmarkVersion = !current ? { ...source, owner: access.owner } : saved;
      if (!initialized || !saved?.owner) {
        if (!input.readHostedVersion) throw new Error("Saved Model versions are unavailable.");
        const { model, version } = await parseAndVerifySavedModelVersionRead(
          await input.readHostedVersion(source), source.teamId, source.modelProjectId, source.versionHash,
        );
        const active = await requireHostedBenchmarkAccess({ ...source, owner: access.owner }, input.access);
        if (active.token !== access.token) throw new Error("The active account changed. Reopen the saved Model version.");
        if (version?.schemaVersion !== "openpond.trainingModelVersion.v1" || version.jobId !== source.jobId)
          throw new Error("Choose an exact saved training version for this Benchmark.");
        startingModel = { source: "trained", label: model.name, baseModel: version.request.baseModel,
          inferenceModelId: null, trainedVersion: version };
      }
    }
    if (!initialized && source?.location === "local") {
      const [lineage, project] = await Promise.all([
        input.store.getModelArtifactLineage(source.versionId), input.store.getModelProject(source.projectId),
      ]);
      if (!project || project.profileId !== request.profileId || !lineage || lineage.modelId !== project.id ||
        lineage.status !== "imported" || lineage.artifactId !== source.artifactId || lineage.bundleHash !== source.bundleHash)
        throw new Error("This exact local Model version is unavailable.");
    }
    const title = titles[resource.kind];
    const ownsFolder = resource.kind === "model" || resource.kind === "benchmark";
    const cwd = ownsFolder
      ? path.join(input.storeDir, "library", resource.kind === "model" ? "models" : "benchmarks", resource.id, "workspace")
      : null;
    const session: CreateSessionRequest = {
      experience: "work",
      provider: request.provider,
      ...(request.modelRef ? { modelRef: request.modelRef } : {}),
      title,
      cwd,
      metadata: {
        resourceDraft: resource,
        ...(resource.kind === "model" ? {
          chatContextSelection: ChatContextTargetSchema.parse({ kind: "model", id: resource.id, location: "local" }),
        } : {}),
      },
    };
    // Reserve the operation before creating a Model or folder. If the process
    // stops during preparation, the same operation finishes the same draft.
    const reserved = await input.createReservedSession(session, reservation);
    if (cwd) await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (resource.kind === "model") {
      await input.store.saveModelProjectConfiguration({
        schemaVersion: "openpond.modelProjectSave.v1",
        operationId: operation,
        expectedRevision: 0,
        project: {
          id: resource.id,
          profileId: resource.profileId,
          name: title,
          objective: null,
          defaultBaseModel: null,
          defaultDestinationId: null,
          trainingSetup: ModelProjectTrainingSetupSchema.parse({}),
        },
      });
    }
    if (resource.kind === "benchmark") {
      if (!initialized) await benchmarkScopes.createDraft(reserved.id, {
        schemaVersion: "openpond.experimentDraft.v1",
        id: resource.id,
        operationType: "evaluate",
        name: title,
        ...(startingModel ? { startingModel } : {}),
      });
      return await input.store.getSession(reserved.id) ?? reserved;
    }
    return reserved;
  };
}
