import { z } from "zod";
import { TaskRequiredOutputSchema } from "./taskset-draft-core.js";

const Id = z.string().trim().min(1).max(240);
const Text = z.string().trim().min(1).max(20_000);
export const PreparedQualificationWitnessSchema = z.object({
  id: Id, label: z.enum(["positive", "incorrect", "incomplete", "adversarial"]),
  output: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.object({
    path: TaskRequiredOutputSchema.shape.path, mediaType: TaskRequiredOutputSchema.shape.mediaType,
    base64: z.string().max(8 * 1024 * 1024),
  }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.artifacts.map(artifact => artifact.path)).size !== value.artifacts.length)
    ctx.addIssue({ code: "custom", message: "Qualification artifacts must have distinct paths." });
});

/** Generated from original requirements before seeing the authored checker or
 * proposed answers. The plan remains privileged, unqualified evidence. */
export const PreparedQualificationPlanSchema = z.object({
  schemaVersion: z.literal("openpond.preparedQualificationPlan.v1"),
  requirementRefs: z.array(Id).min(1).max(100),
  supported: z.boolean(), limitations: z.array(Text).max(20),
  independentVerifier: z.object({
    runtime: z.enum(["isolated_javascript", "sandbox_process"]),
    source: z.string().trim().min(1).max(200_000), exportName: z.literal("verify"),
    timeoutMs: z.number().int().min(1).max(60_000),
  }).strict().nullable(),
  witnesses: z.array(PreparedQualificationWitnessSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.requirementRefs).size !== value.requirementRefs.length || new Set(value.witnesses.map(item => item.id)).size !== value.witnesses.length)
    ctx.addIssue({ code: "custom", message: "Qualification evidence identities must be distinct." });
  if (value.supported && (!value.independentVerifier || value.limitations.length
    || ["positive", "incorrect", "incomplete", "adversarial"].some(label => !value.witnesses.some(witness => witness.label === label))))
    ctx.addIssue({ code: "custom", message: "Supported qualification needs a complete verifier and witness population without unresolved evidence gaps." });
});
export type PreparedQualificationPlan = z.infer<typeof PreparedQualificationPlanSchema>;
export type PreparedQualificationWitness = z.infer<typeof PreparedQualificationWitnessSchema>;

/** A second, blinded adjudication sees source requirements and actual witness
 * outputs, but no planned labels, verifier code or claimed checker verdicts. */
export const PreparedWitnessAdjudicationSchema = z.object({
  schemaVersion: z.literal("openpond.preparedWitnessAdjudication.v1"),
  witnesses: z.array(z.object({
    id: Id,
    failureMode: z.enum(["none", "incorrect", "incomplete", "adversarial", "unverifiable"]),
    requirements: z.array(z.object({ reference: Id, status: z.enum(["satisfied", "violated", "unverifiable"]), reason: Text }).strict()).min(1).max(100),
  }).strict()).min(4).max(20),
}).strict();
export type PreparedWitnessAdjudication = z.infer<typeof PreparedWitnessAdjudicationSchema>;

export const PreparedCheckerAuditSchema = z.object({
  schemaVersion: z.literal("openpond.preparedCheckerAudit.v1"),
  requirements: z.array(z.object({ reference: Id, adequatelyChecked: z.boolean(), oracleAdequatelyChecked: z.boolean(), reason: Text }).strict()).min(1).max(100),
  executionIsolationPassed: z.boolean(),
  futureEvidenceLeak: z.boolean(), unresolvedLimitations: z.array(Text).max(20),
  passed: z.boolean(),
}).strict();
