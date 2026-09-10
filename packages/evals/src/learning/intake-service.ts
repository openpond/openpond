import { createRewardBinding } from "../rewards.js";
import { previewTaskIntake } from "./intake.js";
import { intakeId } from "./intake-contracts.js";
import { LearningDomainError } from "./errors.js";
import { LearningSourceSchema, TaskDefinitionSchema, TaskExampleSubmissionSchema, learningRef, sealLearningContent } from "./contracts.js";
import { learningEvidenceId, type LearningTransaction, type LearningResourcePointer } from "./repository.js";
import type { LearningCommand } from "./operations.js";
import { createLearningTextAsset, verifyLearningTextAsset, type LearningTextAsset } from "./assets.js";

export async function importTaskIntake(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "import_intake" }>, now: string,
  submit: (transaction: LearningTransaction, input: Extract<LearningCommand, { action: "submit_example" }>) => Promise<LearningResourcePointer>,
): Promise<LearningResourcePointer[]> {
  const preview = previewTaskIntake(input);
  if (preview.contentHash !== input.expectedPreviewHash) throw new LearningDomainError("task_intake_preview_changed", 409);
  if (new Set(input.recordIds).size !== input.recordIds.length) throw new LearningDomainError("task_intake_duplicate_selection", 422);
  const selected = input.recordIds.map(id => {
    const record = preview.records.find(record => record.id === id);
    if (!record) throw new LearningDomainError("task_intake_record_missing", 422, "Choose only valid records from the current preview.");
    return record;
  });
  const id = `intake-${preview.contentHash}`;
  // Keep the exact uploaded text once, privately, instead of duplicating a
  // complete session/bundle in every normalized turn. Parts concatenate in
  // path/index order and never split a UTF-16 surrogate pair.
  const sourceAssets: LearningTextAsset["asset"][] = [];
  for (const file of input.files) {
    let start = 0, part = 0;
    do {
      let end = Math.min(start + 131_072, file.text.length);
      if (end < file.text.length && file.text.charCodeAt(end - 1) >= 0xd800 && file.text.charCodeAt(end - 1) <= 0xdbff) end--;
      const asset = createLearningTextAsset({ text: file.text.slice(start, end), path: `${id}/${file.path}.part-${String(part++).padStart(4, "0")}`,
        mediaType: "text/plain", visibility: "host_private" });
      const existing = await transaction.get("asset", asset.id, 1);
      if (existing) verifyLearningTextAsset(existing, asset.asset);
      else await transaction.put("asset", asset, 0);
      sourceAssets.push(asset.asset); start = end;
    } while (start < file.text.length);
  }
  let source = await transaction.get("source", id);
  if (!source) {
    const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `${id}-binding`, revision: 1,
      sources: [], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, []);
    const definition = TaskDefinitionSchema.parse(sealLearningContent({
      schemaVersion: "openpond.taskDefinition.v1", id: `${id}-definition`, revision: 1, name: input.name,
      description: `Imported ${input.format} records. Labels and task admission remain separate.`,
      instructions: "Respond to the retained request using its supplied context.", category: "custom", familyNamespace: `intake-${input.format}`,
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, rewardBinding: learningRef(binding), harness: null,
      contextRequirements: preview.records.some(record => record.needsContext) ? ["Review the imported history and configure its reusable input, tools and runtime before admitting tasks."] : [],
      execution: { policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput", "evaluatorContext"], hiddenGraderRefs: [], connectedAppScopes: [] },
        environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false,
          deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] },
    }));
    source = LearningSourceSchema.parse(sealLearningContent({ schemaVersion: "openpond.learningSource.v1", id, revision: 1, name: input.name,
      kind: "direct", taskDefinition: learningRef(definition), enabled: true, allowedSplits: ["train", "validation", "test", "frozen_eval"],
      mapping: null, adapterVersion: `openpond.intake.${input.format}.v1` }));
    await transaction.put("binding", binding, 0);
    await transaction.put("definition", definition, 0);
    await transaction.put("source", source, 0);
  }
  const pointers: LearningResourcePointer[] = [{ kind: "source", id: source.id, revision: source.revision }];
  for (const record of selected) {
    const attemptId = intakeId("attempt", [record.id, record.sourceHash]);
    const existing = await transaction.get("evidence", learningEvidenceId(source.id, record.id, attemptId), 1);
    pointers.push(await submit(transaction, { action: "submit_example", operationId: input.operationId,
      example: TaskExampleSubmissionSchema.parse({ schemaVersion: "openpond.taskExample.v1", sourceId: source.id,
        idempotencyKey: intakeId("record", [preview.contentHash, record.id]), taskDefinition: source.taskDefinition,
        exampleId: record.id, attemptId, occurredAt: record.occurredAt ?? existing?.submission.occurredAt ?? now,
        familyKey: record.familyKey, split: record.split, input: record.input, observedOutput: record.observedOutput, expected: record.expected,
        evaluatorContext: { intake: { format: preview.format, uploadHash: preview.contentHash, sourceHash: record.sourceHash,
          needsContext: record.needsContext, warnings: record.warnings, timestampOrigin: record.occurredAt ? "source" : "import_time", metadata: record.metadata } },
        assets: sourceAssets, provenance: { sourceRecordRef: record.sourceId, mappingHash: null },
      }),
    }));
  }
  return pointers;
}
