import { TaskDefinitionSchema, createLearningTextAsset, learningRef, sealLearningContent } from "@openpond/evals/learning";
import { RewardBindingSchema, RewardReleaseSchema, compileBoundGraders } from "@openpond/evals/rewards";
import { TasksetReleaseSchema, type TaskRecord } from "@openpond/evals/tasksets";
import { ModelStarterSchema, validateResolvedModelStarter } from "openpond-sdk/model-starters";

export const INVOICE_VERIFIER_SOURCE = `function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function verify({ output, expectedOutput }) {
  if (!expectedOutput) throw new Error('The reference invoice output is required.');
  const passed = canonical(output) === canonical(expectedOutput);
  return { score: passed ? 1 : 0, passed, feedback: passed ? 'Invoice fields match the supplied document.' : 'A field is missing, unsupported, extra, or differs from the supplied document.' };
}`;

const INSTRUCTIONS = "Extract only facts explicitly present in the supplied invoice text. Return the required JSON object and no prose. Use null for missing supplier, invoice number, date, currency, subtotal, tax, or total. Preserve line-item order. Do not infer an omitted total from arithmetic or invent missing information.";
const nullableText = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const OUTPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["supplier", "invoiceNumber", "invoiceDate", "currency", "lineItems", "subtotal", "tax", "total"], properties: {
  supplier: nullableText, invoiceNumber: nullableText, invoiceDate: nullableText, currency: nullableText, subtotal: nullableNumber, tax: nullableNumber, total: nullableNumber,
  lineItems: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "quantity", "unitPrice", "lineTotal"], properties: { description: { type: "string" }, quantity: { type: "number" }, unitPrice: { type: "number" }, lineTotal: { type: "number" } } } },
} };

/** Deterministic original fixtures. Entire customer families stay in one split. */
function invoiceTasks(): TaskRecord[] {
  const families = [
    ["train", "Cedar Office"], ["train", "Harbor Tools"], ["train", "Orchard Paper"], ["train", "Summit Parts"],
    ["validation", "Riverstone Supply"], ["validation", "Maple Workshop"],
    ["frozen_eval", "Willow Equipment"], ["frozen_eval", "Juniper Stationery"],
  ] as const;
  return families.flatMap(([split, supplier], familyIndex) => Array.from({ length: 10 }, (_, index) => {
    const quantity = 1 + index % 4;
    const unitCents = 375 + familyIndex * 117 + index * 29;
    const secondCents = 525 + index * 31;
    const subtotalCents = quantity * unitCents + secondCents;
    const taxCents = index % 3 === 0 ? Math.round(subtotalCents * 0.05) : 0;
    const invoiceNumber = `INV-${familyIndex + 1}-${String(index + 1).padStart(3, "0")}`;
    const invoiceDate = `2026-08-${String(index + 1).padStart(2, "0")}`;
    const currency = familyIndex % 2 ? "EUR" : "USD";
    const missing = index % 5;
    const lineItems = [
      { description: "Storage box", quantity, unitPrice: unitCents / 100, lineTotal: quantity * unitCents / 100 },
      { description: "Packing tape", quantity: 1, unitPrice: secondCents / 100, lineTotal: secondCents / 100 },
    ];
    const header = [missing === 4 ? null : `Supplier: ${supplier}`, `Invoice: ${invoiceNumber}`, missing === 1 ? null : `Date: ${invoiceDate}`, missing === 2 ? null : `Currency: ${currency}`].filter(Boolean);
    const totals = [`Subtotal: ${(subtotalCents / 100).toFixed(2)}`, `Tax: ${(taxCents / 100).toFixed(2)}`, missing === 3 ? null : `Total: ${((subtotalCents + taxCents) / 100).toFixed(2)}`].filter(Boolean);
    const lines = lineItems.map(item => `${item.description} | quantity ${item.quantity} | unit price ${item.unitPrice.toFixed(2)} | line total ${item.lineTotal.toFixed(2)}`);
    return { id: `invoice-${familyIndex}-${index}`, clusterKey: `invoice-customer-${familyIndex}`, split,
      input: { prompt: "Extract this invoice into the required JSON record.", document: [...header, "Items:", ...lines, ...totals].join("\n") },
      expectedOutput: { supplier: missing === 4 ? null : supplier, invoiceNumber, invoiceDate: missing === 1 ? null : invoiceDate, currency: missing === 2 ? null : currency, lineItems, subtotal: subtotalCents / 100, tax: taxCents / 100, total: missing === 3 ? null : (subtotalCents + taxCents) / 100 },
      policyVisibleContext: { instructions: INSTRUCTIONS }, privilegedContextRef: null, artifactRefs: [], tags: ["original-synthetic", "plain-text-invoice", missing ? "missing-field" : "complete"] };
  }));
}

export function createInvoiceStarterPackage() {
  const asset = createLearningTextAsset({ text: INVOICE_VERIFIER_SOURCE, path: "invoice-verifier.mjs", mediaType: "application/javascript", visibility: "verifier" });
  const reward = RewardReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardRelease.v1", id: "starter-invoice-reward", revision: 1, name: "Invoice accuracy", description: "Exact fields, line items, declared totals and explicit unknowns.", implementation: { kind: "custom_verifier", verifierRef: asset.asset, exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" }, rawScore: { minimum: 0, maximum: 1 }, assets: [asset.asset] }));
  const binding = RewardBindingSchema.parse(sealLearningContent({ schemaVersion: "openpond.rewardBinding.v1", id: "starter-invoice-quality", revision: 1, name: "Invoice accuracy", description: "Every extracted field must match the document.", sources: [{ graderId: "invoice-accuracy", reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }));
  const definition = TaskDefinitionSchema.parse(sealLearningContent({ schemaVersion: "openpond.taskDefinition.v1", id: "starter-invoice-format", revision: 1, name: "Plain-text invoice", description: "Extract an invoice already available as text. OCR is outside this package.", instructions: INSTRUCTIONS, category: "structured", familyNamespace: "original-invoice-customers-v1", inputSchema: { type: "object", properties: { prompt: { type: "string" }, document: { type: "string" } }, required: ["prompt", "document"], additionalProperties: false }, outputSchema: OUTPUT_SCHEMA, rewardBinding: learningRef(binding), harness: null,
    execution: { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: ["invoice-accuracy"], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] } }));
  const taskset = TasksetReleaseSchema.parse(sealLearningContent({ schemaVersion: "openpond.tasksetRelease.v2", id: "starter-invoice-tasks", revision: 1, ...definition.execution, tasks: invoiceTasks(), graders: compileBoundGraders(binding, [reward]), metadata: { starter: { taskDefinition: learningRef(definition), rewardBinding: learningRef(binding) }, provenance: { author: "OpenPond", source: "Original deterministic synthetic invoice documents", license: "MIT" } } }));
  const starter = ModelStarterSchema.parse(sealLearningContent({ schemaVersion: "openpond.modelStarter.v1", id: "invoice-extractor", revision: 1, name: "Invoice extractor", description: "Extract invoice fields and line items from supplied text, preserving missing information.", category: "extraction", taskset: learningRef(taskset), taskDefinition: learningRef(definition), rewardBinding: learningRef(binding), rewards: [learningRef(reward)], assets: [learningRef(asset)], previewTaskIds: ["invoice-0-0", "invoice-0-1", "invoice-0-3"], startingModel: { schemaVersion: "openpond.baseModelPreference.v1", modelId: "Qwen/Qwen3-0.6B", revision: null, tokenizerRevision: null, chatTemplateHash: null, modelAssetId: null, source: "managed" }, supportedMethods: ["sft"], defaultMethod: "sft", provenance: { author: "OpenPond", license: "MIT", sourceDescription: "Original synthetic invoices; customer families are disjoint across train, validation and frozen evaluation." }, evidence: { verifierFixtures: null, baseline: null, training: null, evaluation: null } }));
  return validateResolvedModelStarter({ starter, taskset, taskDefinition: definition, rewardBinding: binding, rewards: [reward], assets: [asset] });
}
