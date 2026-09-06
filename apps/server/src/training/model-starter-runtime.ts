import { z } from "zod";
import { GraderFixtureSchema, TasksetSourceRefSchema } from "@openpond/contracts";
import { OpenPondModelStarterCatalogClient } from "openpond-sdk/model-starter-catalog";
import { ModelProjectVersionedRefSchema } from "openpond-sdk/model-projects";
import { parseModelStarterCreationRequest, previewModelStarter } from "openpond-sdk/model-starters";
import type { SqliteStore } from "../store/store.js";
import { createModelStarterCreationService } from "./model-starter-creation-service.js";
import { scanAndRedactEvidence } from "./privacy.js";

const AuthoringSchema = z.object({
  schemaVersion: z.literal("openpond.starterAuthoring.v1"),
  publishedAt: z.string().datetime({ offset: true }),
  reviewedBy: z.string().trim().min(1).max(500),
  licensingStatus: z.literal("approved"),
  approvedTrainingTaskIds: z.array(z.string().min(1).max(500)).min(1).max(100_000),
  graderFixtures: z.array(GraderFixtureSchema).min(1).max(100_000),
}).strict();

export function createModelStarterRuntime(input: {
  store: SqliteStore; home: string;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
}) {
  async function client() {
    const access = await input.resolveAccess();
    return new OpenPondModelStarterCatalogClient({ baseUrl: access.apiBaseUrl, apiKey: access.token, teamId: access.teamId });
  }
  const creation = createModelStarterCreationService({ store: input.store, home: input.home, catalog: {
    resolve: async (reference, profileId) => {
      const resolved = await (await client()).resolve(reference);
      const authoring = AuthoringSchema.parse(resolved.taskset.metadata.starterAuthoring);
      const scan = scanAndRedactEvidence(JSON.stringify(resolved));
      const source = TasksetSourceRefSchema.parse({
        schemaVersion: "openpond.generatedDatasetSource.v1", kind: "generated", id: `starter-source-${resolved.starter.contentHash.slice(0, 40)}`,
        profileId, title: resolved.starter.name, sourceHash: resolved.starter.contentHash, occurredAt: authoring.publishedAt,
        licensingStatus: authoring.licensingStatus, secretScanStatus: scan.secretStatus, piiScanStatus: scan.piiStatus,
        generatorId: "openpond-starter-catalog", generatorVersion: "1", generatorHash: resolved.taskset.contentHash, seed: 0,
        metadata: { provenance: resolved.starter.provenance, reviewedBy: authoring.reviewedBy, privacyScanner: "openpond-evidence-v1", findings: scan.findings },
      });
      return { package: resolved, source, fixtures: authoring.graderFixtures, approvedTrainingTaskIds: authoring.approvedTrainingTaskIds };
    },
  } });
  return {
    async list(query: unknown) { return (await client()).list(z.object({ limit: z.number().optional(), afterId: z.string().optional() }).strict().parse(query)); },
    async preview(reference: unknown) { return previewModelStarter(await (await client()).resolve(ModelProjectVersionedRefSchema.parse(reference))); },
    async create(value: unknown) {
      const request = parseModelStarterCreationRequest(value);
      // The authenticated local-server token owns all local Profiles, matching
      // local model authoring. Producer credentials cannot reach this route.
      return creation.create(request, request.profileId);
    },
  };
}
