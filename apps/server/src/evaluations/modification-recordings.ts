import { z } from "zod";
import { canonicalJson, canonicalSha256, ModificationRecordingListQuerySchema, ModificationRecordingPageSchema,
  ModificationRecordingSchema, verifyModificationRecording, verifyModificationRecordingRead, verifyModificationRecordingRequest } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";

export class ModificationRecordingError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
const Id = z.string().trim().min(1).max(240);
export function createLocalModificationRecordings(input: {
  store: SqliteStore; teamId(): Promise<string>; actorId(): Promise<string>;
  resolveAccess(): Promise<{ apiBaseUrl: string }>;
}) {
  async function scope(teamId: string) {
    const [currentTeam, actorId, access] = await Promise.all([input.teamId(), input.actorId(), input.resolveAccess()]);
    if (teamId !== currentTeam) throw new ModificationRecordingError("modification_recording_scope_mismatch", 403, "Choose the current workspace.");
    return { teamId, actorId, accountScopeHash: await canonicalSha256({ teamId, actorId, apiOrigin: new URL(access.apiBaseUrl).origin }) };
  }
  async function fence(current: Awaited<ReturnType<typeof scope>>) {
    if ((await scope(current.teamId)).accountScopeHash !== current.accountScopeHash)
      throw new ModificationRecordingError("modification_recording_account_changed", 409, "The active account changed. Reopen this observation.");
  }
  return {
    async record(raw: unknown) {
      const command = await verifyModificationRecordingRequest(raw), owner = await scope(command.teamId);
      const document = { request: command.request, result: command.result };
      const content = { schemaVersion: "openpond.modificationRecording.v1" as const,
        id: `observation-${await canonicalSha256({ scope: owner.accountScopeHash, operationId: command.operationId })}`,
        ...owner, operationId: command.operationId, commandHash: await canonicalSha256(command), name: command.name,
        projectId: command.projectId, method: command.method, custody: "local" as const, provenance: "external_observation" as const,
        measurementAttestation: "unattested" as const, model: command.request.model,
        inputHash: await canonicalSha256(command.request), resultHash: command.result.contentHash,
        artifact: { contentHash: await canonicalSha256(document), sizeBytes: Buffer.byteLength(canonicalJson(document)) },
        counts: { prompts: command.request.prompts.length, variants: command.request.variants.length,
          outcomes: command.result.outcomes.length, captures: command.result.captures.length }, createdAt: new Date().toISOString() };
      const recording = ModificationRecordingSchema.parse({ ...content, contentHash: await canonicalSha256(content) });
      await fence(owner);
      let retained;
      try { retained = await input.store.retainModificationRecording(owner, { recording, document }); }
      catch (error) {
        if (error instanceof Error && error.message === "modification_recording_operation_conflict")
          throw new ModificationRecordingError(error.message, 409, "This operation already retains different observation settings. Retry its original request.");
        throw error;
      }
      await fence(owner);
      return (await verifyModificationRecordingRead(retained, owner.teamId, owner.actorId)).recording;
    },
    async read(id: string, teamId: string) {
      const owner = await scope(Id.parse(teamId)), value = await input.store.readModificationRecording(owner, Id.parse(id));
      await fence(owner);
      if (!value) throw new ModificationRecordingError("modification_recording_not_found", 404, "Observation not found in this account.");
      if (value.recording.accountScopeHash !== owner.accountScopeHash) throw new Error("modification_recording_scope_corrupt");
      return value;
    },
    async list(raw: unknown) {
      const query = ModificationRecordingListQuerySchema.parse(raw), owner = await scope(query.teamId);
      const scopeHash = await canonicalSha256({ ...owner, projectId: query.projectId ?? null, search: query.search ?? "" });
      let afterId: string | undefined;
      if (query.cursor) {
        try {
          const cursor = z.object({ version: z.literal(1), scopeHash: z.string(), afterId: Id }).strict().parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
          if (cursor.scopeHash !== scopeHash) throw new Error("scope");
          afterId = cursor.afterId;
        } catch { throw new ModificationRecordingError("modification_recording_cursor_invalid", 400, "Refresh the observation list before continuing."); }
      }
      const page = await input.store.listModificationRecordings(owner, { ...query, afterId });
      await fence(owner);
      for (const row of page.items) {
        await verifyModificationRecording(row, owner.teamId, owner.actorId);
        if (row.accountScopeHash !== owner.accountScopeHash) throw new Error("modification_recording_scope_corrupt");
      }
      return ModificationRecordingPageSchema.parse({ ...owner, projectId: query.projectId ?? null, items: page.items,
        nextCursor: page.hasMore ? Buffer.from(JSON.stringify({ version: 1, scopeHash, afterId: page.items.at(-1)!.id })).toString("base64url") : null });
    },
  };
}
