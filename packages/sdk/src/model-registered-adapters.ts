import { z } from "zod";
import { assertCanonicalPayloadSize, canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const id = z.string().trim().min(1).max(191).regex(/^[a-zA-Z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ id, contentHash: hash }).strict();
export const RegisteredAdapterBaseProofSchema = z.object({
  modelAssetId: hash, configSha256: hash, tokenizerSha256: hash,
  tokenizerConfigSha256: hash, chatTemplateSha256: hash, weightsSha256: hash,
}).strict();
const artifact = ref.extend({ baseProfileId: id, weightsSha256: hash, configSha256: hash });
const source = ref.extend({ adapterConfigSha256: hash, base: RegisteredAdapterBaseProofSchema });

export const RegisteredAdapterAttachSchema = z.object({
  schemaVersion: z.literal("openpond.registeredAdapterAttach.v1"),
  teamId: id, operationId: id, expectedModelEtag: hash, localVersion: source, artifact,
}).strict();
export const RegisteredAdapterVersionSchema = z.object({
  schemaVersion: z.literal("openpond.registeredAdapterVersion.v1"),
  id, teamId: id, modelProjectId: id, portableProjectId: id, ownerUserId: id,
  localVersion: source, artifact, baseModel: z.object({ repository: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  createdAt: z.iso.datetime(), contentHash: hash,
}).strict();
export const RegisteredAdapterAttachReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.registeredAdapterAttachReceipt.v1"),
  operationId: id, requestHash: hash, version: RegisteredAdapterVersionSchema, contentHash: hash,
}).strict();
const pageSchema = z.object({ versions: z.array(RegisteredAdapterVersionSchema).max(100), nextAfterId: id.nullable() }).strict();
const exactSchema = z.object({ version: RegisteredAdapterVersionSchema }).strict();

export type RegisteredAdapterAttach = z.infer<typeof RegisteredAdapterAttachSchema>;
export type RegisteredAdapterBaseProof = z.infer<typeof RegisteredAdapterBaseProofSchema>;
export type RegisteredAdapterVersion = z.infer<typeof RegisteredAdapterVersionSchema>;
export type RegisteredAdapterAttachReceipt = z.infer<typeof RegisteredAdapterAttachReceiptSchema>;

function identityMismatch() {
  return new OpenPondProtocolError("registered_adapter_identity_mismatch", "The registered adapter response differs from the requested Model, workspace, or adapter.");
}

async function verifyVersion(version: RegisteredAdapterVersion, projectId: string, teamId: string) {
  const { contentHash, ...content } = version;
  const id = `adapter-version-${await canonicalSha256([version.modelProjectId, version.localVersion.id])}`;
  if (version.teamId !== teamId || (version.modelProjectId !== projectId && version.portableProjectId !== projectId) ||
    version.id !== id || await canonicalSha256(content) !== contentHash) throw identityMismatch();
  return version;
}

export function createModelRegisteredAdaptersClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const collection = (projectId: string) => `/v1/model-projects/${encodeURIComponent(id.parse(projectId))}/adapter-versions`;
  const options = (teamId: string, signal?: AbortSignal): RequestInit => ({ headers: { "x-openpond-team-id": id.parse(teamId) }, signal });
  return {
    /** Save an already committed registry artifact as one immutable Model version. */
    async attachRegisteredAdapter(projectId: string, value: RegisteredAdapterAttach, signal?: AbortSignal) {
      const parsed = RegisteredAdapterAttachSchema.parse(value);
      const model = id.parse(projectId);
      assertCanonicalPayloadSize(parsed, 8_192, "Registered adapter attach");
      const result = RegisteredAdapterAttachReceiptSchema.parse(await request(collection(model), {
        ...options(parsed.teamId, signal), method: "POST", body: JSON.stringify(parsed),
      }));
      const { contentHash, ...content } = result;
      const version = await verifyVersion(result.version, model, parsed.teamId);
      if (result.operationId !== parsed.operationId || result.requestHash !== await canonicalSha256({ projectId: model, request: parsed }) ||
        canonicalJson(version.localVersion) !== canonicalJson(parsed.localVersion) || canonicalJson(version.artifact) !== canonicalJson(parsed.artifact) ||
        await canonicalSha256(content) !== contentHash) throw identityMismatch();
      return result;
    },
    async listRegisteredAdapters(projectId: string, teamId: string, query: { afterId?: string; limit?: number; signal?: AbortSignal } = {}) {
      const model = id.parse(projectId);
      const args = new URLSearchParams({ limit: String(z.number().int().min(1).max(100).parse(query.limit ?? 25)) });
      if (query.afterId !== undefined) args.set("afterId", id.parse(query.afterId));
      const page = pageSchema.parse(await request(`${collection(model)}?${args}`, options(teamId, query.signal)));
      return { ...page, versions: await Promise.all(page.versions.map(version => verifyVersion(version, model, teamId))) };
    },
    async getRegisteredAdapter(projectId: string, teamId: string, versionId: string, signal?: AbortSignal) {
      const model = id.parse(projectId);
      const selected = id.parse(versionId);
      const result = exactSchema.parse(await request(`${collection(model)}/${encodeURIComponent(selected)}`, options(teamId, signal)));
      if (result.version.id !== selected) throw identityMismatch();
      return verifyVersion(result.version, model, teamId);
    },
  };
}
