import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SqliteStore } from "../store/store.js";
import { createLocalDatasetService } from "./local-dataset-service.js";
import type { LocalDatasetRecord } from "@openpond/contracts";

// Failure story: a combined catalog must show a workflow's graders without
// serializing its private gold, fixtures or captured source files into list rows.
test("the installation catalog exposes source associations and grader metadata without private data", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-learning-catalog-"));
  const store = new SqliteStore(home);
  try {
    const service = createLocalDatasetService({ store, home });
    const created = await service.request({ action: "create", operationId: "catalog-create", payload: { name: "RFQ facts", draft: {
      metadata: { profileTarget: { profileId: "storage-scholars", workflowId: "rfq-extract-facts" }, privateGold: "never-list-gold" },
      graders: [{ id: "facts", version: "1", label: "Source facts", kind: "content", privileged: true, rewardEligible: true,
        config: { operator: "final_answer_equals_expected", privateGold: "never-list-config" }, metadata: {} }],
      graderFixtures: [{ id: "fixture", taskId: "task", label: "positive", output: { answer: "never-list-fixture" }, infrastructureError: null,
        expectedPassed: true, expectedRewardEligible: true, metadata: {} }],
    } } }) as { record: LocalDatasetRecord };
    const catalog = await service.request({ action: "list", payload: { view: "catalog" } });
    expect(catalog).toMatchObject([{ summary: { name: "RFQ facts", rows: [] }, profileTarget: { profileId: "storage-scholars", workflowId: "rfq-extract-facts" },
      graders: [{ name: "Source facts", privileged: true, rewardEligible: true }] }]);
    const bytes = JSON.stringify(catalog);
    expect(bytes).not.toMatch(/never-list|graderFixtures|sourceRefs|files|config"/);
    const metadata = await service.request({ action: "read", id: created.record.workspace.draft.id, payload: { view: "metadata" } }) as { record: LocalDatasetRecord };
    expect(metadata.record.workspace).not.toHaveProperty("files");
    expect(metadata.record.workspace.draft.id).toBe(created.record.workspace.draft.id);
    await expect(service.request({ action: "read", id: "another-owner", payload: { view: "metadata" } })).rejects.toThrow("not found");
  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});
