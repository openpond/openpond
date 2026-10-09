import type { SqliteDomainContext } from "../store-domain.js";
import { lazyStoreDomain, type StoreDomainLifecycle } from "../store-domain-loader.js";
import type { LearningRepository } from "@openpond/evals/learning";
import type { HumanReviewRepository } from "@openpond/evals/human-review";

export function evaluationStoreMethods(context: SqliteDomainContext, lifecycle: StoreDomainLifecycle) {
  const learning = lazyStoreDomain(lifecycle, () => import("../store-learning.js").then(module => new module.SqliteLearningStore(context)));
  const learningCredentials = lazyStoreDomain(lifecycle, () => import("../store-learning-credentials.js").then(module => new module.SqliteLearningCredentialStore(context)));
  const humanReview = lazyStoreDomain(lifecycle, () => import("../store-human-review.js").then(module => new module.SqliteHumanReviewStore(context)));
  const localExperiments = lazyStoreDomain(lifecycle, () => import("../store-local-experiments.js").then(module => new module.SqliteLocalExperimentStore(context)));
  const evaluationResults = lazyStoreDomain(lifecycle, () => import("../store-evaluation-results.js").then(module => new module.SqliteEvaluationResultStore(context)));
  const preferenceComparison = lazyStoreDomain(lifecycle, () => import("../store-preference-comparison.js").then(module => new module.SqlitePreferenceComparisonStore(context)));
  return {
    ...learning.methods([
      "listLearningScopes",
    ]),
    ...learningCredentials.methods([
      "createLearningSourceCredential",
      "findLearningSourceCredential",
      "listLearningSourceCredentials",
      "revokeLearningSourceCredential",
    ]),
    ...humanReview.methods([
      "humanLiveControl",
      "humanLiveControlReceipt",
      "rememberHumanLocalPublication",
      "forgetHumanLocalPublication",
      "humanLocalPublications",
    ]),
    ...localExperiments.methods([
      "prepareEvaluationOperation",
      "retainEvaluationOperation",
      "readPendingEvaluationOperation",
      "pendingEvaluationOperations",
      "acknowledgeEvaluationOperation",
      "claimLocalExperimentOwner",
      "renewLocalExperimentOwner",
      "releaseLocalExperimentOwner",
      "saveLocalExperiment",
      "readLocalExperiment",
      "recoverLocalExperimentOperation",
      "listLocalExperiments",
      "listLocalExecutionHistory",
      "startLocalExperiment",
      "admitLocalExperimentRun",
      "findLocalExperimentRunOperation",
      "readLocalExperimentRecord",
      "readLocalExperimentSnapshot",
      "readExecutionActivity",
      "listLocalExperimentRecords",
      "readLocalExecution",
      "readLocalExecutionCharges",
      "appendLocalExperimentEvent",
      "localExperimentTrace",
      "localExperimentDiagnosticTrace",
      "startLocalScoringPass",
      "readLocalScoringSelection",
      "localJudgeBudgetTransaction",
      "listLocalExecutions",
      "listLocalScoringPasses",
      "admitLocalCase",
      "settleLocalCase",
      "cancelLocalExecution",
      "finishLocalExecution",
      "recoverLocalExperiments",
      "reserveLocalCharge",
      "markLocalChargeDispatched",
      "settleLocalCharge",
    ]),
    ...evaluationResults.methods([
      "saveProfileEvaluationGrade",
      "getProfileEvaluationGrade",
      "saveProfileEvaluationReceipt",
      "getProfileEvaluationReceipt",
      "saveProfileEvaluationRun",
      "getProfileEvaluationRun",
      "listProfileEvaluationRuns",
      "saveProfileEvaluationComparison",
      "getProfileEvaluationComparison",
      "listProfileEvaluationComparisons",
      "saveProfileEvaluationSuiteRun",
      "getProfileEvaluationSuiteRun",
      "listProfileEvaluationSuiteRuns",
      "saveBenchmarkRun",
      "listBenchmarkRuns",
      "saveBenchmarkComparison",
      "listBenchmarkComparisons",
      "saveEvaluationResult",
      "getEvaluationResult",
      "listEvaluationResults",
    ]),
    ...preferenceComparison.methods([
      "savePreferenceComparisonRelease",
      "getPreferenceComparisonRelease",
      "listPreferenceComparisonReleases",
      "revokePreferenceComparisonRelease",
      "savePreferenceComparisonAssignment",
      "getPreferenceComparisonAssignment",
      "listPreferenceComparisonAssignments",
      "claimPreferenceComparisonAssignment",
      "claimNextPreferenceComparisonAssignment",
      "markPreferenceComparisonUnreviewable",
      "savePreferenceComparisonSubmission",
      "getPreferenceComparisonSubmission",
      "listPreferenceComparisonSubmissions",
      "savePreferenceComparisonCalibration",
      "listPreferenceComparisonCalibrations",
    ]),
    learningRepository(): LearningRepository {
      return { transaction: (scope, callback) => learning.call(store => store.learningRepository().transaction(scope, callback)) };
    },
    humanReviewRepository(): HumanReviewRepository {
      return { transaction: (scope, callback) => humanReview.call(store => store.humanReviewRepository().transaction(scope, callback)) };
    },
    humanReviewLocalEvidence(...args: Parameters<import("../store-human-review.js").SqliteHumanReviewStore["humanReviewLocalEvidence"]>) {
      // Do not queue this read: authority may already own the repository transaction.
      return humanReview.call(store => Promise.resolve(store.humanReviewLocalEvidence(...args)));
    },
  };
}
