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
import type { Session } from "@openpond/contracts/sessions";
import type { SqliteStore } from "../store/store.js";
import type { ReservedSessionCreation } from "../store/session-store.js";
import { createChatExperimentScopes } from "./chat-experiment-scope.js";

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
    });
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
      await benchmarkScopes.createDraft(reserved.id, {
        schemaVersion: "openpond.experimentDraft.v1",
        id: resource.id,
        operationType: "evaluate",
        name: title,
      });
      return await input.store.getSession(reserved.id) ?? reserved;
    }
    return reserved;
  };
}
