import { z } from "zod";
import {
  ExperimentCaseInspectionSchema,
  ExperimentListQuerySchema,
  RunExperimentSchema,
  PrepareHarnessExperimentSchema,
  ExperimentScoringRequestSchema,
  RunDiagnosticsQuerySchema,
} from "openpond-sdk/experiments";
import type { AddTool } from "./types.js";
import type { Clients } from "./clients.js";
import { ById, Cursor, Empty, Hash, Id } from "./common.js";

export function addExperiments(add: AddTool, c: Clients) {
  add(
    "experiments_defaults",
    "Read the current evaluation spend and token defaults without running work.",
    Empty,
    "read",
    () => c.experiments.defaults(),
  );
  add(
    "experiments_harness_sources",
    "Discover released authorized Harness targets and readiness.",
    Cursor,
    "read",
    (v) => c.experiments.harnessSources(v),
  );
  add(
    "experiments_prepare_harness",
    "Resolve an exact hosted Harness evaluation request and spend ceiling before launching.",
    PrepareHarnessExperimentSchema,
    "write",
    (v) => c.experiments.prepareHarness(v),
  );
  add(
    "experiments_run",
    "Launch an immutable evaluation request under its explicit spend ceiling. Reuse operationId for reconciliation after a lost response.",
    RunExperimentSchema,
    "execute",
    (v) => c.experiments.run(v),
  );
  add(
    "experiments_list",
    "List bounded evaluation runs in the connected workspace.",
    ExperimentListQuerySchema,
    "read",
    (v) => c.experiments.list(v),
  );
  add(
    "experiments_get",
    "Inspect an evaluation's lifecycle, immutable request, accounting and result references.",
    ById,
    "read",
    (v) => c.experiments.get(v.id),
  );
  add(
    "experiments_result",
    "Read and verify retained execution and scoring evidence for a completed evaluation.",
    ById,
    "read",
    (v) => c.experiments.result(v.id),
  );
  add(
    "experiments_diagnostics",
    "Read bounded append-only diagnostics using sequence/call cursors and optional manifest identity.",
    RunDiagnosticsQuerySchema.extend({ id: Id, manifestHash: Hash.optional() }),
    "read",
    ({ id, ...v }) => c.experiments.diagnostics(id, v),
  );
  add(
    "experiments_case",
    "Read a bounded retained case/trace page for an exact execution and receipt. This never executes inference or grading.",
    z
      .object({
        executionId: Id,
        receiptId: Id,
        manifestHash: Hash.optional(),
        afterId: Id.optional(),
      })
      .strict(),
    "read",
    ({ executionId, receiptId, ...v }) => c.cases.case(executionId, receiptId, v),
    { output: ExperimentCaseInspectionSchema },
  );
  add(
    "experiments_compare",
    "Compare compatible retained evaluation evidence. Refuses incompatible manifests; creates no workload.",
    z.object({ baselineId: Id, candidateId: Id }).strict(),
    "read",
    (v) => c.experiments.compare(v.baselineId, v.candidateId),
  );
  add(
    "experiments_cancel",
    "Explicitly request cancellation and read back the actual evaluation lifecycle.",
    ById,
    "cancel",
    (v) => c.experiments.cancel(v.id),
  );
  add(
    "experiments_duplicate",
    "Launch a new evaluation from the original pinned snapshot with a new retained operation identity.",
    ById.extend({ operationId: Id }),
    "execute",
    (v) => c.experiments.duplicate(v.id, v.operationId),
  );
  add(
    "experiments_score",
    "Launch a separate scoring pass against pinned execution evidence and grader mappings.",
    ExperimentScoringRequestSchema,
    "execute",
    (v) => c.experiments.score(v),
  );
  add(
    "scoring_passes_list",
    "List scoring passes for one retained execution.",
    z
      .object({
        executionId: Id,
        afterId: Id.optional(),
        executionKind: z.literal("recorded_evidence").optional(),
      })
      .strict(),
    "read",
    ({ executionId, ...v }) => c.experiments.scoringPasses(executionId, v),
  );
  add(
    "scoring_passes_get",
    "Inspect the lifecycle, request and accounting of a scoring pass.",
    ById,
    "read",
    (v) => c.experiments.scoringPass(v.id),
  );
  add(
    "scoring_passes_result",
    "Read and verify exact retained scoring-pass evidence.",
    ById,
    "read",
    (v) => c.experiments.scoringResult(v.id),
  );
  add(
    "scoring_passes_cancel",
    "Cancel one scoring pass without changing its retained execution evidence.",
    ById,
    "cancel",
    (v) => c.experiments.cancelScoringPass(v.id),
  );
  add(
    "comparison_budgets_create",
    "Reserve one shared comparison budget for an explicit set of operation IDs; does not dispatch evaluation.",
    z
      .object({
        id: Id,
        operationIds: z.array(Id).min(1).max(100),
        maximumSpendUsd: z.number().positive().max(10_000),
      })
      .strict(),
    "execute",
    (v) => c.experiments.createComparisonBudget(v),
  );
  add(
    "comparison_budgets_get",
    "Read shared comparison admission and remaining/settled spend.",
    ById,
    "read",
    (v) => c.experiments.comparisonBudget(v.id),
  );
}
