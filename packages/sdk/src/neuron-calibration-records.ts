import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { NeuronResidualCalibrationExportSchema, parseAndVerifyNeuronResidualCalibrationExport } from "./neuron-residual-calibration.js";
import { NeuronSteeringReferenceSchema } from "./neuron-steering.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Name = z.string().trim().min(1).max(200);
const Timestamp = z.iso.datetime();

/** Custody proves the retained original bytes and scope. Qualification is a
 * separate runtime authority decision, never granted by importing an export. */
export const NeuronCalibrationRecordContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronCalibrationRecord.v1"),
  teamId: Id, ownerUserId: Id, projectId: Id.nullable(), name: Name,
  artifact: NeuronResidualCalibrationExportSchema,
  revision: z.number().int().positive(), archived: z.boolean(), createdAt: Timestamp, updatedAt: Timestamp,
}).strict();
export const NeuronCalibrationRecordSchema = NeuronCalibrationRecordContentSchema.extend({ contentHash: Hash }).strict();
export type NeuronCalibrationRecord = z.infer<typeof NeuronCalibrationRecordSchema>;
export const NeuronCalibrationImportRequestSchema = z.object({
  teamId: Id, operationId: Id, projectId: Id.nullable(), name: Name,
  artifact: NeuronResidualCalibrationExportSchema,
}).strict();
export type NeuronCalibrationImportRequest = z.infer<typeof NeuronCalibrationImportRequestSchema>;
export const NeuronCalibrationReadQuerySchema = z.object({ teamId: Id }).strict();
export const NeuronCalibrationArchiveRequestSchema = z.object({
  teamId: Id, operationId: Id, expectedRevision: z.number().int().positive(), contentHash: Hash,
}).strict();
export type NeuronCalibrationArchiveRequest = z.infer<typeof NeuronCalibrationArchiveRequestSchema>;
export const NeuronCalibrationReceiptContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronCalibrationReceipt.v1"),
  teamId: Id, actorId: Id, operationId: Id, requestHash: Hash, record: NeuronCalibrationRecordSchema,
}).strict();
export const NeuronCalibrationReceiptSchema = NeuronCalibrationReceiptContentSchema.extend({ contentHash: Hash }).strict();
export type NeuronCalibrationReceipt = z.infer<typeof NeuronCalibrationReceiptSchema>;

export const NeuronCalibrationListQuerySchema = z.object({
  projectId: Id.optional(), modelHash: Hash.optional(), archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(2048).optional(),
}).strict();
export const NeuronCalibrationSummarySchema = z.object({
  reference: NeuronSteeringReferenceSchema, teamId: Id, ownerUserId: Id, projectId: Id.nullable(), name: Name,
  exportHash: Hash, modelHash: Hash, source: z.object({ id: Id, contentHash: Hash }).strict(),
  implementationHash: Hash, layerCount: z.number().int().min(1).max(512),
  revision: z.number().int().positive(), archived: z.boolean(), createdAt: Timestamp, updatedAt: Timestamp,
}).strict();
export const NeuronCalibrationPageContentSchema = z.object({
  schemaVersion: z.literal("openpond.neuronCalibrationPage.v1"), teamId: Id, ownerUserId: Id,
  query: NeuronCalibrationListQuerySchema, items: z.array(NeuronCalibrationSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict();
export const NeuronCalibrationPageSchema = NeuronCalibrationPageContentSchema.extend({ contentHash: Hash }).strict();
export type NeuronCalibrationPage = z.infer<typeof NeuronCalibrationPageSchema>;

export async function parseAndVerifyNeuronCalibrationRecord(raw: unknown, expected: { teamId?: string; ownerUserId?: string; id?: string } = {}) {
  const value = NeuronCalibrationRecordSchema.parse(raw), { contentHash, ...content } = value;
  await parseAndVerifyNeuronResidualCalibrationExport(value.artifact);
  if (contentHash !== await canonicalSha256(content) || expected.teamId && value.teamId !== expected.teamId
    || expected.ownerUserId && value.ownerUserId !== expected.ownerUserId || expected.id && value.artifact.calibration.id !== expected.id)
    throw new OpenPondProtocolError("neuron_calibration_record_mismatch", "The original calibration record differs from its artifact or authorized workspace.");
  return value;
}

export async function parseAndVerifyNeuronCalibrationReceipt(raw: unknown, request: NeuronCalibrationImportRequest | NeuronCalibrationArchiveRequest, id?: string) {
  const value = NeuronCalibrationReceiptSchema.parse(raw), { contentHash, ...content } = value;
  const importing = "artifact" in request;
  const parsed = importing ? NeuronCalibrationImportRequestSchema.parse(request) : NeuronCalibrationArchiveRequestSchema.parse(request);
  await parseAndVerifyNeuronCalibrationRecord(value.record, { teamId: parsed.teamId, ownerUserId: value.actorId, id });
  if (contentHash !== await canonicalSha256(content) || value.teamId !== parsed.teamId || value.operationId !== parsed.operationId
    || value.requestHash !== await canonicalSha256(importing ? parsed : { id, request: parsed }))
    throw new OpenPondProtocolError("neuron_calibration_receipt_mismatch", "Retry the original calibration custody command.");
  if ("artifact" in parsed) {
    if (canonicalJson(value.record.artifact) !== canonicalJson(parsed.artifact) || value.record.projectId !== parsed.projectId
      || value.record.name !== parsed.name || value.record.archived || value.record.revision !== 1)
      throw new OpenPondProtocolError("neuron_calibration_receipt_mismatch", "The imported record differs from the original measured export.");
  } else if (!value.record.archived || value.record.revision !== parsed.expectedRevision + 1 || value.record.artifact.contentHash !== parsed.contentHash) {
    throw new OpenPondProtocolError("neuron_calibration_receipt_mismatch", "The archive differs from the original artifact and record revision.");
  }
  return value;
}

export function createNeuronCalibrationClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async importNeuronCalibration(raw: NeuronCalibrationImportRequest) {
      const body = NeuronCalibrationImportRequestSchema.parse(raw);
      await parseAndVerifyNeuronResidualCalibrationExport(body.artifact);
      return parseAndVerifyNeuronCalibrationReceipt(await request("/v1/training/neuron-calibrations", {
        method: "POST", body: JSON.stringify(body),
      }), body);
    },
    async getNeuronCalibration(teamId: string, id: string) {
      const scope = Id.parse(teamId), key = Id.parse(id);
      return parseAndVerifyNeuronCalibrationRecord(await request(`/v1/training/neuron-calibrations/${encodeURIComponent(key)}?${new URLSearchParams({ teamId: scope })}`), { teamId: scope, id: key });
    },
    async archiveNeuronCalibration(id: string, raw: NeuronCalibrationArchiveRequest) {
      const key = Id.parse(id), body = NeuronCalibrationArchiveRequestSchema.parse(raw);
      return parseAndVerifyNeuronCalibrationReceipt(await request(`/v1/training/neuron-calibrations/${encodeURIComponent(key)}/archive`, {
        method: "POST", body: JSON.stringify(body),
      }), body, key);
    },
    async listNeuronCalibrations(teamId: string, raw: z.input<typeof NeuronCalibrationListQuerySchema> = {}) {
      const scope = Id.parse(teamId), query = Object.fromEntries(Object.entries(NeuronCalibrationListQuerySchema.parse(raw)).filter(([, value]) => value !== undefined)) as z.infer<typeof NeuronCalibrationListQuerySchema>, params = new URLSearchParams({ teamId: scope });
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const page = NeuronCalibrationPageSchema.parse(await request(`/v1/training/neuron-calibrations?${params}`)), { contentHash, ...content } = page;
      if (page.teamId !== scope || canonicalJson(page.query) !== canonicalJson(query) || contentHash !== await canonicalSha256(content)
        || page.items.length > query.limit || new Set(page.items.map(row => row.reference.id)).size !== page.items.length
        || page.nextCursor !== null && (page.items.length !== query.limit || page.nextCursor === query.cursor))
        throw new OpenPondProtocolError("neuron_calibration_page_mismatch", "Refresh calibration history in its original workspace.");
      for (const [index, row] of page.items.entries()) if (row.teamId !== scope || row.ownerUserId !== page.ownerUserId
        || row.archived !== query.archived || query.projectId && row.projectId !== query.projectId || query.modelHash && row.modelHash !== query.modelHash
        || index && page.items[index - 1]!.reference.id >= row.reference.id)
        throw new OpenPondProtocolError("neuron_calibration_page_mismatch", "Calibration history returned a different creator or source scope.");
      return page;
    },
  };
}
