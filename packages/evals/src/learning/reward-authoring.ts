import { RewardReleaseSchema, createRewardRelease, type RewardRelease } from "../rewards.js";
import { assertBoundedTaskJson } from "../task-schema.js";
import { RewardAuthoringFieldsSchema, RewardFixtureAuthoringFieldsSchema, type AuthoringDraftFor } from "./authoring.js";
import { createLearningTextAsset, verifyLearningTextAsset, type LearningTextAsset } from "./assets.js";
import { LearningJsonObjectSchema } from "./contracts.js";
import { LearningDomainError } from "./errors.js";

export type RewardAuthoringFields = AuthoringDraftFor<"reward">["fields"];
export const DEFAULT_REWARD_VERIFIER_SOURCE = `export function verify({ output, expectedOutput }) {
  if (!expectedOutput || !Object.hasOwn(expectedOutput, "answer")) {
    throw new Error("An expected answer is required.");
  }
  const passed = output.answer === expectedOutput.answer;
  return { score: passed ? 1 : 0, passed, feedback: passed ? "Answer matched" : "Answer differed" };
}`;

/** Both editors and execution owners compile the same draft bytes. No publication occurs here. */
export function compileRewardAuthoring(input: { id: string; fields: RewardAuthoringFields; base: RewardRelease | null }): { reward: RewardRelease; assets: LearningTextAsset[] } {
  assertBoundedTaskJson(input, 262_144);
  const fields = RewardAuthoringFieldsSchema.parse(input.fields);
  const base = input.base ? RewardReleaseSchema.parse(input.base) : null;
  if (base && base.id !== input.id) throw new LearningDomainError("reward_authoring_base_mismatch", 422);
  const fixtureAsset = fields.fixtures?.length ? createLearningTextAsset({ text: JSON.stringify(fields.fixtures), path: "reward-fixtures.json", mediaType: "application/json", visibility: "verifier" }) : null;
  let asset: LearningTextAsset | null = null;
  let implementation: RewardRelease["implementation"];
  let calibrationCheckRef: RewardRelease["calibrationCheckRef"];
  if (fields.kind === "custom_verifier") {
    asset = createLearningTextAsset({ text: fields.code, path: "verifier.mjs", mediaType: "application/javascript", visibility: "verifier" });
    implementation = { kind: fields.kind, verifierRef: asset.asset, exportName: fields.exportName, timeoutMs: authoringNumber(fields.timeout, "Time limit"), networkPolicy: "none",
      ...(base?.implementation.kind === "custom_verifier" && base.implementation.runtime !== undefined ? { runtime: base.implementation.runtime } : {}) };
  } else if (fields.kind === "model_judge" || fields.kind === "human") {
    if (!fields.rubric.trim()) throw new LearningDomainError("reward_rubric_required", 422, "Write the rubric before checking or publishing this Reward.");
    asset = createLearningTextAsset({ text: fields.rubric, path: "rubric.md", mediaType: "text/markdown", visibility: "verifier" });
    if (fields.kind === "human") implementation = { kind: fields.kind, rubricRef: asset.asset, reviewerRole: fields.reviewerRole };
    else {
      const model = { providerId: fields.providerId, modelId: fields.modelId, revision: fields.modelRevision.trim() || null };
      const temperature = authoringNumber(fields.temperature, "Temperature");
      const previous = base?.implementation;
      const unchanged = previous?.kind === "model_judge" && previous.rubricRef.contentHash === asset.asset.contentHash
        && previous.model?.providerId === model.providerId && previous.model?.modelId === model.modelId
        && previous.model?.revision === model.revision && (previous.temperature ?? 0) === temperature
        && base?.fixtureSetRef?.contentHash === fixtureAsset?.asset.contentHash;
      implementation = { kind: fields.kind, rubricRef: asset.asset, model, temperature, calibrationStatus: unchanged ? previous.calibrationStatus : "pending" };
      if (unchanged) calibrationCheckRef = base?.calibrationCheckRef;
    }
  } else if (fields.kind === "learned_model") {
    parseRewardAuthoringObject(fields.inputContract, "Model input contract");
    asset = createLearningTextAsset({ text: fields.inputContract, path: "input-contract.json", mediaType: "application/json", visibility: "verifier" });
    implementation = { kind: fields.kind, modelVersion: { id: fields.learnedId, contentHash: fields.learnedHash }, inputContract: asset.asset };
  } else if (fields.kind === "state") implementation = { kind: fields.kind, config: { fields: split(fields.fields) } };
  else if (fields.kind === "content") implementation = { kind: fields.kind, config: { outputField: fields.outputField, expectedField: fields.expectedField, ...(fields.expectedValue ? { expectedValue: fields.expectedValue } : {}) } };
  else if (fields.kind === "schema") implementation = { kind: fields.kind, config: { jsonSchema: parseRewardAuthoringObject(fields.schema, "Output schema") } };
  else if (fields.kind === "artifact") implementation = { kind: fields.kind, config: { refIncludes: fields.reference } };
  else implementation = { kind: fields.kind, config: { requiredEvents: split(fields.events) } };
  const assets = [...(asset ? [asset] : []), ...(fixtureAsset ? [fixtureAsset] : [])];
  const reward = createRewardRelease({
    schemaVersion: "openpond.rewardRelease.v1", id: input.id, revision: (base?.revision ?? 0) + 1,
    name: fields.name, description: fields.description, implementation,
    rawScore: fields.kind === "learned_model" ? { minimum: authoringNumber(fields.minimum, "Minimum score"), maximum: authoringNumber(fields.maximum, "Maximum score") } : { minimum: 0, maximum: 1 },
    assets: assets.map(value => value.asset), ...(fixtureAsset ? { fixtureSetRef: fixtureAsset.asset } : {}),
    ...(calibrationCheckRef ? { calibrationCheckRef } : {}),
  });
  return { reward, assets };
}

export function rewardAuthoringFields(reward: RewardRelease | null, sourceAsset: LearningTextAsset | null, fixtureAsset: LearningTextAsset | null = null): RewardAuthoringFields {
  const implementation = reward?.implementation;
  const ref = implementation && "verifierRef" in implementation ? implementation.verifierRef
    : implementation && "rubricRef" in implementation ? implementation.rubricRef
    : implementation && "inputContract" in implementation ? implementation.inputContract : null;
  if (ref && !sourceAsset) throw new LearningDomainError("reward_source_required", 422);
  const source = ref && sourceAsset ? verifyLearningTextAsset(sourceAsset, ref) : "";
  if (reward?.fixtureSetRef && !fixtureAsset) throw new LearningDomainError("reward_fixtures_required", 422);
  const fixtures = reward?.fixtureSetRef && fixtureAsset ? RewardFixtureAuthoringFieldsSchema.array().max(50).parse(JSON.parse(verifyLearningTextAsset(fixtureAsset, reward.fixtureSetRef))) : [];
  const config = implementation && "config" in implementation ? implementation.config : {};
  return {
    name: reward?.name ?? "", description: reward?.description ?? "", kind: implementation?.kind ?? "state",
    fields: strings(config.fields).join(", ") || "answer", outputField: text(config.outputField) || "text", expectedField: text(config.expectedField) || "text", expectedValue: text(config.expectedValue),
    schema: JSON.stringify(config.jsonSchema ?? { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, null, 2),
    reference: text(config.refIncludes), events: strings(config.requiredEvents).join(", "),
    code: implementation?.kind === "custom_verifier" ? source : DEFAULT_REWARD_VERIFIER_SOURCE,
    exportName: implementation?.kind === "custom_verifier" ? implementation.exportName ?? "verify" : "verify",
    timeout: String(implementation?.kind === "custom_verifier" ? implementation.timeoutMs : 5_000),
    rubric: implementation?.kind === "model_judge" || implementation?.kind === "human" ? source : "",
    providerId: implementation?.kind === "model_judge" ? implementation.model?.providerId ?? "" : "",
    modelId: implementation?.kind === "model_judge" ? implementation.model?.modelId ?? "" : "",
    modelRevision: implementation?.kind === "model_judge" ? implementation.model?.revision ?? "" : "",
    temperature: String(implementation?.kind === "model_judge" ? implementation.temperature ?? 0 : 0),
    reviewerRole: implementation?.kind === "human" ? implementation.reviewerRole : "Subject matter reviewer",
    learnedId: implementation?.kind === "learned_model" ? implementation.modelVersion.id : "",
    learnedHash: implementation?.kind === "learned_model" ? implementation.modelVersion.contentHash : "",
    inputContract: implementation?.kind === "learned_model" ? source : "{}",
    minimum: String(reward?.rawScore.minimum ?? 0), maximum: String(reward?.rawScore.maximum ?? 1),
    ...(fixtures.length ? { fixtures } : {}),
  };
}

export function parseRewardAuthoringObject(value: string, label: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    assertBoundedTaskJson(parsed, 131_072);
    return LearningJsonObjectSchema.parse(parsed);
  } catch { throw new LearningDomainError("reward_authoring_json_invalid", 422, `${label} must be a JSON object.`); }
}
export function authoringNumber(value: string, label: string): number {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number)) throw new LearningDomainError("reward_authoring_number_invalid", 422, `${label} must be a finite number.`);
  return number;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function split(value: string): string[] { return value.split(",").map(part => part.trim()).filter(Boolean); }
