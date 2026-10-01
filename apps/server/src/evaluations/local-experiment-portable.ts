import { assertContentHash, contentHash } from "@openpond/harness";
import { createExperimentManifest, createExperimentResult, type ExperimentManifest } from "@openpond/evals/experiments";
import { tasksetRunMetricPolicy } from "@openpond/evals/metrics";
import { validateTasksetPackage } from "openpond-sdk/taskset-packages";
import type { SqliteLocalExperimentStore } from "../store/store-local-experiments.js";
import { localRetainedCase } from "./local-experiment-output.js";
import { LocalExperimentError, type LocalExperimentDefinition } from "./local-experiment-contract.js";

type StoredExecution = Awaited<ReturnType<SqliteLocalExperimentStore["readLocalExecution"]>>;
type Charges = Awaited<ReturnType<SqliteLocalExperimentStore["readLocalExecutionCharges"]>>;

/** Called only after account, workspace and Project authorization. This is a
 * projection of sealed SQLite evidence; it cannot execute or regrade a case. */
export function localPortableExperiment(input: {
  retained: StoredExecution;
  definition: LocalExperimentDefinition;
  package: unknown;
  graders: LocalExperimentDefinition["graders"];
  charges: Charges;
  retainedConfigurationHash?:string;
}) {
  const { execution, cases } = input.retained;
  const definition = input.definition;
  const value = validateTasksetPackage(input.package);
  assertContentHash(definition, "Local Experiment definition");
  if (execution.definition.id !== definition.id || execution.definition.revision !== definition.revision
    || execution.definition.contentHash !== definition.contentHash || execution.teamId !== definition.teamId
    || execution.ownerActorId !== definition.ownerActorId || execution.packageHash !== value.contentHash
    || definition.packageHash !== value.contentHash)
    throw new LocalExperimentError("local_portable_source_conflict", "Retained execution differs from its exact definition or Dataset package.");
  if (!execution.completedAt || cases.some(row => row.status === "pending" || row.status === "running"))
    throw new LocalExperimentError("local_comparison_not_terminal", "Wait for the complete retained execution before comparing.", 422);
  if(input.retainedConfigurationHash&&input.retainedConfigurationHash!==definition.contentHash)
    throw new LocalExperimentError("local_portable_source_conflict","Historical configuration differs from its sealed original hash.");
  const policy = definition.configuration.request.policy;
  const target: ExperimentManifest["target"] = policy.kind === "fixture"
    ? { kind: "fixture", configurationHash: contentHash(policy) }
    : policy.kind === "hosted_harness"
      ? { kind: "harness", source: policy.source, model: { modelId: definition.model.modelId, configurationHash: definition.model.configurationHash } }
      : policy.harness
        ? { kind: "agent", source: policy.harness, model: { modelId: definition.model.modelId, configurationHash: definition.model.configurationHash } }
        : { kind: "model", modelId: definition.model.modelId, configurationHash: definition.model.configurationHash };
  const population = definition.configuration.request.population;
  const members = new Map(population.map(member => [member.receiptId, member]));
  if (members.size !== cases.length || new Set(cases.map(row => row.receiptId)).size !== cases.length)
    throw new LocalExperimentError("local_portable_population_conflict", "Retained cases differ from the admitted population.");
  const manifest = createExperimentManifest({
    schemaVersion: "openpond.experimentManifest.v1", id: execution.id,
    name: definition.configuration.request.name ?? "Experiment", teamId: execution.teamId,
    operationId: execution.operationId, maximumCostUsd: execution.maximumCostUsd,
    dataset: definition.configuration.request.taskset, target,
    execution: {
      packageHash: value.contentHash,
      runtimeTargetHash: contentHash({ adapter: target.kind === "model" ? definition.model.providerId === "claude-code" ? "openpond.local-claude-process.v1" : "openpond.local-model-case.v1"
        : target.kind === "agent" ? "openpond.local-native-harness-case.v1" : "openpond.local-profile-case.v1",
        placement: "local", ...(definition.configuration.request.policy.kind === "hosted_chat" && definition.configuration.request.policy.localRuntime ? {runtime:definition.configuration.request.policy.localRuntime} : {}), environment: value.taskset.environment,
        tools: value.taskset.tools, capabilities: value.taskset.capabilities,
        source: target.kind === "agent" || target.kind === "harness" ? target.source : null }),
      metricPolicyHash: contentHash(tasksetRunMetricPolicy(value.taskset)),
      ...(!input.retainedConfigurationHash ? { compatibility: {
        protocol: "openpond.evaluation-execution.v1" as const, targetKind: target.kind,
      } } : {}),
    },
    lineage: { definition: input.retainedConfigurationHash ? execution.definition : null,
      execution: execution.sourceExecution ? { id: execution.sourceExecution.id, contentHash: execution.sourceExecution.executionHash }
        : { id: execution.id, contentHash: execution.executionHash },
      scoringPassId: execution.kind === "scoring" ? execution.id : null },
    evaluators: input.graders.map(pin => ({ release: pin.release ?? { id: pin.id, revision: pin.version, contentHash: pin.contentHash },
      feedbackKey: pin.feedbackKey, configurationHash: contentHash({ graderHash: pin.contentHash, mappings: pin.mappings ?? [] }), output: "score", categories: [] })),
    population: population.map(member => ({ caseId: member.taskId, seed: member.seed, fixtureId: member.fixtureId })),
    createdAt: execution.createdAt,
  });
  const result = createExperimentResult({
    schemaVersion: "openpond.experimentResult.v1", manifest: { id: manifest.id, contentHash: manifest.contentHash },
    status: execution.status === "completed" ? "completed" : execution.status === "cancelled" ? "cancelled" : "failed",
    completedAt: execution.completedAt,
    cases: cases.map(row => {
      const member = members.get(row.receiptId);
      if (!member || member.taskId !== row.admission.taskId || member.seed !== row.admission.seed)
        throw new LocalExperimentError("local_portable_population_conflict", "Retained task or seed differs from its admitted population.");
      const retained = row.result ? localRetainedCase(row.result) : null;
      if (retained?.grade && retained.grade.selectionHash !== contentHash(input.graders))
        throw new LocalExperimentError("local_portable_grader_conflict", "Retained grades differ from their exact selected grader pins.");
      const native = retained?.attempt.native ?? retained?.attempt.profileNative ?? retained?.attempt.externalProcess;
      const completed = row.status === "completed" && retained?.attempt.status === "completed" && row.error === null;
      const components = new Map(retained?.grade?.grades.flatMap(grade => grade.components).map(component => [component.graderId, component]));
      return {
        identity: { caseId: member.taskId, seed: member.seed, fixtureId: member.fixtureId },
        status: completed ? "completed" as const : row.status === "cancelled" ? "cancelled" as const : "failed" as const,
        output: retained?.attempt.output ?? null,
        error: completed ? null : { code: `local_case_${row.status}`, message: (row.error ?? retained?.attempt.error ?? "Verified successful case output is unavailable.").slice(0, 2000) },
        feedback: manifest.evaluators.map((evaluator, index) => {
          const grade = components.get(input.graders[index]!.id);
          const scored = completed && grade?.score !== null && grade?.score !== undefined;
          return { feedbackKey: evaluator.feedbackKey, evaluator: evaluator.release,
            status: completed && grade?.status === "pending" ? "pending" as const : scored ? "scored" as const : "unavailable" as const,
            value: scored ? grade!.score : null, passed: scored ? grade!.passed : null,
            reasoning: grade?.feedback.join("\n").slice(0, 20_000) ?? null, evidenceRefs: [] };
        }),
        usage: localCaseUsage(input.charges.filter(charge => charge.caseId === row.receiptId)),
        traceRef: retained ? { id: row.receiptId, contentHash: native?.traceHash ?? retained.attempt.contentHash, mediaType: "application/json", sizeBytes: null } : null,
        startedAt: native?.startedAt ?? null, completedAt: native?.completedAt ?? null,
      };
    }),
  }, manifest);
  const {definition:_privateConfiguration,...publicExecution}=execution;void _privateConfiguration;
  return { execution:publicExecution, manifest, result };
}

function localCaseUsage(charges: Charges) {
  const dispatched = charges.filter(charge => charge.status !== "released");
  const measuredCost = dispatched.every(charge => charge.status === "settled" && charge.costUsd !== null);
  const tokenSum = (key: "promptTokens" | "completionTokens") => {
    if (!dispatched.length) return null;
    const values = dispatched.map(charge => charge.usage && typeof charge.usage === "object"
      ? (charge.usage as Record<string, unknown>)[key] : null);
    return values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      ? (values as number[]).reduce((sum, value) => sum + value, 0) : null;
  };
  const inputTokens = tokenSum("promptTokens"), outputTokens = tokenSum("completionTokens");
  return { inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    costUsd: measuredCost ? dispatched.reduce((sum, charge) => sum + charge.costUsd!, 0) : null, latencyMs: null };
}
