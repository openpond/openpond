import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ChatModelRef,
  type LearnedPreferenceRewardBinding,
} from "@openpond/contracts";

import { DatasetSourcePickerDialog, type DatasetCreateSource } from "../datasets/DatasetSourcePickerDialog";
import { HuggingFaceDatasetImportDialog } from "../datasets/HuggingFaceDatasetImportDialog";
import { TasksetDraftEditor } from "../datasets/TasksetDraftEditor";
import { api } from "../../api";
import { useCreateImproveRuns } from "../../hooks/useCreateImproveRuns";
import { LabWorkproductDetail } from "./LabWorkproductDetail";
import { labWorkproductProjection } from "./lab-workproducts";
import { LabsView, type LabPrimaryTab } from "./LabsView";
import { LabDatasetsPage, type TasksetDetailTab } from "./LabDatasetsPage";
import { LabEvaluationsPage, type EvaluationDetailTab } from "./LabEvaluationsPage";
import { LabHumanReviewsPage } from "./LabHumanReviewsPage";
import { LabScoringPage } from "./LabScoringPage";
import type { LabScorerCreateInput } from "./LabScorerCreateDialog";
import { LabModelCreateDialog, type LabModelCreateInput } from "./LabModelCreateDialog";
import { LabModelsPage } from "./LabModelsPage";
import { LabModelsOverviewPage } from "./LabModelsOverviewPage";
import { LabsRouteModelUseDialog } from "./LabsRouteModelUseDialog";
import { LabServingPage } from "./LabServingPage";
import { ModelRunEditorPage } from "./ModelRunEditorPage";
import { labModelVersions } from "./lab-models";
import { newProject, nextModelName } from "./model-run-editor-helpers";
import { buildTrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";
import { useErrorToast } from "../../app/AppToastContext";
import { trainingModelRunSyncKey } from "./LabsRouteSections";
import {
  modelProjectRoute,
  modelLibraryRoute,
  modelsPath,
  modelsSectionFromRoute,
  navigateModelsRoute,
  useModelsRoute,
} from "./lab-primary-tab-state";
import type { LabsRouteProps } from "./labs-route-types";
import {
  labTabForModelsSection,
  libraryResourceLabel,
  modelEntryKeyFromRoute,
  modelEntryRouteId,
  modelsSectionForLabTab,
  titleCaseLabel,
} from "./labs-route-models";

export type { LabsRouteProps } from "./labs-route-types";

export function LabsRoute({
  closeDetailKind,
  closeDetailRequestId,
  onAnswerQuestion,
  onApplyCandidate,
  onApprove,
  onCancel,
  candidateReview,
  onCandidateReviewChange,
  onDetailOpenChange,
  onSkillSelectionChange,
  onNewModel,
  onOpenPullRequest,
  onOpenCandidateFiles,
  onOpenRunConversation,
  onPause,
  onReconcilePullRequest,
  onRejectCandidate,
  onResume,
  onRevise,
  profileView,
  training,
}: LabsRouteProps) {
  const profile = profileView.payload?.profile ?? null;
  const profileId = profile?.activeProfile ?? "default";
  const createImprove = useCreateImproveRuns({
    connection: profileView.connection,
    profileId,
  });
  useErrorToast(createImprove.error);
  useErrorToast(training.training.error);
  const modelRunSyncKey = useMemo(
    () => trainingModelRunSyncKey(training.training.payload),
    [training.training.payload]
  );
  const profileAgentRunSyncKey = useMemo(
    () => createImprove.runs
      .filter((run) =>
        run.target.kind === "agent"
        && ["ready_local", "released", "published_hosted"].includes(run.state)
      )
      .map((run) => `${run.id}:${run.revision}:${run.state}`)
      .sort()
      .join("|"),
    [createImprove.runs]
  );
  const modelsRoute = useModelsRoute();
  const selectedProjectRouteId =
    modelsRoute?.kind === "project" ? modelsRoute.projectId : null;
  const activeTab = labTabForModelsSection(
    modelsSectionFromRoute(modelsRoute ?? { kind: "index" }),
  );
  const setActiveTab = useCallback(
    (tab: LabPrimaryTab) => {
      navigateModelsRoute(
        modelProjectRoute(selectedProjectRouteId, modelsSectionForLabTab(tab)),
      );
    },
    [selectedProjectRouteId],
  );
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    null,
  );
  const [modelCreateOpen, setModelCreateOpen] = useState(false);
  const [benchmarkLaunch, setBenchmarkLaunch] = useState<{
    modelId: string;
    model: ChatModelRef;
  } | null>(null);
  const [datasetCreateRoute, setDatasetCreateRoute] = useState<
    "source" | DatasetCreateSource | null
  >(null);
  const [datasetDraftId, setDatasetDraftId] = useState<string | null>(null);
  const [modelEditorSection, setModelEditorSection] = useState<"run" | "dataset">("run");
  const [modelEditorName, setModelEditorName] = useState<string | null>(null);
  const [modelUseVersionId, setModelUseVersionId] = useState<string | null>(
    null
  );

  const workproducts = useMemo(
    () =>
      labWorkproductProjection({
        profile,
        training: training.training.payload,
        runs: createImprove.runs,
      }),
    [createImprove.runs, profile, training.training.payload]
  );
  const models = useMemo(
    () => {
      const activeHostedTeamId =
        training.settingsPreferences.defaultTeamId?.trim() ?? null;
      const visibleIds = new Set(
        (training.training.payload?.modelProjects ?? [])
          .filter(
            (project) =>
              project.hosted === null ||
              (activeHostedTeamId !== null &&
                project.hosted.teamId === activeHostedTeamId),
          )
          .map((project) => project.id),
      );
      return workproducts.filter(
        (workproduct) =>
          workproduct.kind === "model" && visibleIds.has(workproduct.id),
      );
    },
    [
      training.settingsPreferences.defaultTeamId,
      training.training.payload?.modelProjects,
      workproducts,
    ],
  );
  const selected = models.find(
    (workproduct) => workproduct.id === selectedProjectRouteId,
  ) ?? null;
  const modelProjects = training.training.payload?.modelProjects ?? [];
  const activeHostedTeamId =
    training.settingsPreferences.defaultTeamId?.trim() ?? null;
  const scopedModelProjects = useMemo(
    () =>
      modelProjects.filter(
        (project) =>
          project.hosted === null ||
          (activeHostedTeamId !== null &&
            project.hosted.teamId === activeHostedTeamId),
      ),
    [activeHostedTeamId, modelProjects],
  );
  useEffect(() => {
    if (!profileView.connection) return;
    let cancelled = false;
    void api.bootstrap(profileView.connection)
      .then((payload) => {
        if (!cancelled) profileView.onPayload(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          profileView.onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileView.connection, profileView.onError, profileView.onPayload]);
  useEffect(() => {
    if (!modelsRoute || typeof window === "undefined") return;
    if (modelsRoute.kind === "index" && scopedModelProjects.length > 0) {
      return;
    }
    const canonicalPath = modelsPath(modelsRoute);
    if (
      window.location.pathname !== canonicalPath ||
      window.location.search
    ) {
      navigateModelsRoute(modelsRoute, "replace");
    }
  }, [modelsRoute, scopedModelProjects.length]);
  useEffect(() => {
    setSelectedDatasetId(
      (modelsRoute?.kind === "project" && modelsRoute.section === "tasksets") ||
      (modelsRoute?.kind === "library" && modelsRoute.section === "tasksets")
        ? modelsRoute.resourceId
        : null,
    );
  }, [modelsRoute]);
  useEffect(() => {
    if (!modelRunSyncKey) return;
    void createImprove.refresh();
  }, [createImprove.refresh, modelRunSyncKey]);
  useEffect(() => {
    if (!profileAgentRunSyncKey || !profileView.connection) return;
    let cancelled = false;
    void api.bootstrap(profileView.connection)
      .then((payload) => {
        if (!cancelled) profileView.onPayload(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          profileView.onError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileAgentRunSyncKey, profileView.connection, profileView.onError, profileView.onPayload]);
  useEffect(() => {
    onSkillSelectionChange(null);
  }, [onSkillSelectionChange]);
  useEffect(() => {
    if (closeDetailRequestId <= 0) return;
    setSelectedDatasetId(null);
    if (closeDetailKind === null || closeDetailKind === "model") {
      navigateModelsRoute({ kind: "index" });
      return;
    }
    const resourceSection = closeDetailKind === "dataset"
      ? "tasksets"
      : closeDetailKind === "evaluation"
        ? "evaluations"
        : closeDetailKind === "review"
          ? "reviews"
          : "scoring";
    if (
      modelsRoute?.kind === "project" &&
      resourceSection !== "reviews"
    ) {
      navigateModelsRoute(modelProjectRoute(
        modelsRoute.projectId,
        resourceSection === "evaluations" ? "evals" : resourceSection,
      ));
      return;
    }
    navigateModelsRoute(modelLibraryRoute(resourceSection));
  }, [closeDetailKind, closeDetailRequestId, modelsRoute]);
  useEffect(() => {
    setModelEditorName(null);
  }, [training.launchRequest?.id]);
  useEffect(() => {
    if (training.launchRequest) {
      onDetailOpenChange({
         kind: "model",
         kindLabel: "Model Projects",
         kindOnSelect: () => document.getElementById("model-run-editor-cancel")?.click(),
         workproductLabel: null,
         segments: [
           { label: modelEditorName ?? "Model" },
           ...(modelEditorSection === "dataset" ? [{ label: "New Taskset" }] : []),
         ],
      });
      return;
    }
    if (modelsRoute?.kind === "library") {
      const definitions = {
        projects: { kind: "model" as const, label: "Model Projects" },
        tasksets: { kind: "dataset" as const, label: "Taskset Library" },
        scoring: { kind: "scoring" as const, label: "Scoring" },
        evaluations: { kind: "evaluation" as const, label: "Evaluations" },
        reviews: { kind: "review" as const, label: "Human Review" },
      };
      const definition = definitions[modelsRoute.section];
      const resourceLabel = libraryResourceLabel(
        modelsRoute.section,
        modelsRoute.resourceId,
        training.training.payload,
      );
      onDetailOpenChange({
        kind: definition.kind,
        kindLabel: definition.label,
        kindOnSelect: () => navigateModelsRoute(modelLibraryRoute(modelsRoute.section)),
        workproductLabel: resourceLabel,
        workproductOnSelect: modelsRoute.resourceId
          ? () => navigateModelsRoute(modelLibraryRoute(modelsRoute.section, modelsRoute.resourceId))
          : undefined,
        segments: modelsRoute.detailTab
          ? [{ label: titleCaseLabel(modelsRoute.detailTab) }]
          : [],
      });
      return;
    }
    if (modelsRoute?.kind === "project" && modelsRoute.section === "tasksets") {
      const tasksetLabel = selectedDatasetId
        ? libraryResourceLabel("tasksets", selectedDatasetId, training.training.payload)
        : null;
      onDetailOpenChange({
        kind: "dataset",
        kindLabel: "Model Projects",
        kindOnSelect: () => navigateModelsRoute({ kind: "index" }),
        workproductLabel: selected?.name ?? modelsRoute.projectId,
        workproductOnSelect: () => navigateModelsRoute(modelProjectRoute(modelsRoute.projectId)),
        segments: [
          {
            label: "Tasksets",
            onSelect: () => navigateModelsRoute(modelProjectRoute(modelsRoute.projectId, "tasksets")),
          },
          ...(datasetCreateRoute === "build"
            ? [{ label: "New Taskset" }]
            : tasksetLabel
              ? [{
                  label: tasksetLabel,
                  onSelect: () => navigateModelsRoute({
                    kind: "project",
                    projectId: modelsRoute.projectId,
                    section: "tasksets",
                    resourceId: selectedDatasetId,
                    detailTab: null,
                  }),
                }]
              : []),
          ...(modelsRoute.detailTab
            ? [{ label: titleCaseLabel(modelsRoute.detailTab) }]
            : []),
        ],
      });
      return;
    }
    if (
      modelsRoute?.kind === "project" &&
      (modelsRoute.section === "scoring" || modelsRoute.section === "evals")
    ) {
      const scoring = modelsRoute.section === "scoring";
      const resourceLabel = libraryResourceLabel(
        scoring ? "scoring" : "evaluations",
        modelsRoute.resourceId,
        training.training.payload,
      );
      onDetailOpenChange({
        kind: scoring ? "scoring" : "evaluation",
        kindLabel: "Model Projects",
        kindOnSelect: () => navigateModelsRoute({ kind: "index" }),
        workproductLabel: selected?.name ?? modelsRoute.projectId,
        workproductOnSelect: () => navigateModelsRoute(modelProjectRoute(modelsRoute.projectId)),
        segments: [
          {
            label: scoring ? "Scoring" : "Evaluations",
            onSelect: () => navigateModelsRoute(modelProjectRoute(
              modelsRoute.projectId,
              modelsRoute.section,
            )),
          },
          ...(resourceLabel
            ? [{
                label: resourceLabel,
                onSelect: () => navigateModelsRoute({ ...modelsRoute, detailTab: null }),
              }]
            : []),
          ...(modelsRoute.detailTab
            ? [{ label: titleCaseLabel(modelsRoute.detailTab) }]
            : []),
        ],
      });
      return;
    }
    if (modelsRoute?.kind === "project" && modelsRoute.section === "serving") {
      onDetailOpenChange({
        kind: "model",
        kindLabel: "Model Projects",
        kindOnSelect: () => navigateModelsRoute({ kind: "index" }),
        workproductLabel: selected?.name ?? modelsRoute.projectId,
        workproductOnSelect: () => navigateModelsRoute(modelProjectRoute(modelsRoute.projectId)),
        segments: [{ label: "Serving" }],
      });
      return;
    }
    if (!selected) onDetailOpenChange(null);
  }, [
    datasetCreateRoute,
    modelsRoute,
    onDetailOpenChange,
    selected,
    selectedDatasetId,
    modelEditorSection,
    modelEditorName,
    training.launchRequest,
    training.training.payload?.modelTasksets,
    training.training.payload?.modelRuns,
    training.training.payload?.modelProjects,
    training.training.payload?.tasksets,
  ]);
  useEffect(() => () => onDetailOpenChange(null), [onDetailOpenChange]);

  function useModel(modelId: string) {
    const workproduct = workproducts.find(
      (candidate) => candidate.kind === "model" && candidate.id === modelId,
    );
    if (!workproduct) return;
    const versions = labModelVersions(
      workproduct,
      createImprove.runs,
      training.training.payload,
    );
    const version =
      versions.find((candidate) => candidate.current) ??
      versions.find((candidate) => candidate.lineage.promotable) ??
      null;
    if (!version?.taskset) return;
    training.onChatWithModel(
      buildTrainingModelChatHandoff({
        modelId: version.lineage.id,
        taskset: version.taskset,
      })
    );
  }

  function openDatasetCreation() {
    setDatasetCreateRoute("source");
    setDatasetDraftId(null);
    setSelectedDatasetId(null);
    if (modelsRoute?.kind === "library") {
      navigateModelsRoute(modelLibraryRoute("tasksets"));
    } else {
      setActiveTab("tasksets");
    }
  }

  function closeDatasetCreation() {
    setDatasetCreateRoute(null);
    setDatasetDraftId(null);
  }

  function openDatasetBuilderChat(taskset?: {
    id: string;
    name: string;
    objective: string;
  } | null) {
    const target = taskset
      ? `Help me improve the ${taskset.name} Taskset.`
      : "Help me create a Taskset.";
    profileView.onSkillCommand?.(
      `$openpond-taskset-authoring ${target}`,
      "openpond",
    );
    closeDatasetCreation();
  }

  function finishDatasetCreation(tasksetId: string | null) {
    setDatasetCreateRoute(null);
    setDatasetDraftId(null);
    if (selectedProjectRouteId) {
      navigateModelsRoute({
        kind: "project",
        projectId: selectedProjectRouteId,
        section: "tasksets",
        resourceId: tasksetId,
        detailTab: null,
      });
      return;
    }
    navigateModelsRoute(modelLibraryRoute("tasksets", tasksetId));
  }

  function openModelRunEditor(
    initialTasksetId?: string,
    learnedPreferenceReward?: LearnedPreferenceRewardBinding | null,
  ) {
    setModelEditorSection("run");
    onNewModel(initialTasksetId, learnedPreferenceReward);
  }

  async function createModel(input: LabModelCreateInput): Promise<boolean> {
    const project = {
      ...newProject(profileId, input.description, undefined, input.name),
      defaultBaseModel: input.defaultBaseModel,
    };
    const saved = await training.training.actions.saveModelProject(project);
    if (!saved) return false;
    setModelCreateOpen(false);
    navigateModelsRoute(modelProjectRoute(saved.id));
    if (input.purpose === "benchmark") {
      setBenchmarkLaunch({
        modelId: saved.id,
        model: input.benchmarkModel ?? training.defaultModel,
      });
    }
    profileView.onToast?.(`${saved.name} created.`, "success");
    return true;
  }

  async function createScorer(
    input: LabScorerCreateInput,
    modelProjectId: string | null,
  ): Promise<boolean> {
    const result = await training.training.actions.createScorer(
      input.grader,
      input.tasksetId,
      modelProjectId,
    );
    if (!result) return false;
    if (result.hostedSync.state === "sync_failed") {
      profileView.onToast?.(
        `${input.grader.label} was created locally, but its hosted Taskset release did not sync.`,
        "info",
      );
    } else {
      profileView.onToast?.(`${input.grader.label} created.`, "success");
    }
    return true;
  }
  const closeSelectedWorkproduct = useCallback(
    () => navigateModelsRoute({ kind: "index" }),
    [],
  );

  function renderLaunchEditor(returnToTasksetId: string | null) {
    const request = training.launchRequest;
    const payload = training.training.payload;
    if (!request || !payload) return null;
    return (
      <ModelRunEditorPage
        connection={profileView.connection}
        initialObjective={request.objective}
        initialTasksetId={request.initialTasksetId}
        initialLearnedPreferenceReward={request.learnedPreferenceReward}
        profileId={profileId}
        training={training.training}
        onCancel={() => {
          training.onLaunchHandled(request.id);
        }}
        onFinished={async (modelId, tasksetId) => {
          training.onSelectedTasksetIdChange(tasksetId);
          training.onDetailTasksetIdChange(tasksetId);
          training.onLaunchHandled(request.id);
          if (returnToTasksetId) {
            setSelectedDatasetId(tasksetId);
            setActiveTab("tasksets");
          } else {
            navigateModelsRoute(modelProjectRoute(modelId));
          }
          await createImprove.refresh();
        }}
        onNameChange={setModelEditorName}
        onSectionChange={setModelEditorSection}
        onSaved={async (modelId) => {
          training.onLaunchHandled(request.id);
          if (returnToTasksetId) {
            setSelectedDatasetId(returnToTasksetId);
            setActiveTab("tasksets");
          } else {
            navigateModelsRoute(modelProjectRoute(modelId));
          }
        }}
        onOpenProviderSettings={training.onOpenProviderSettings}
        renderDatasetBuilder={(onCreated, onUseExistingDataset) => (
          <TasksetDraftEditor
            defaultModel={training.defaultModel}
            modelProjectId={selected?.id ?? null}
            training={training.training}
            onBack={onUseExistingDataset}
            onOpenChat={openDatasetBuilderChat}
            onPublished={onCreated}
            onUseExistingTaskset={onUseExistingDataset}
          />
        )}
      />
    );
  }

  return (
    <LabsView
      activeTab={activeTab}
      showHeader={
        !training.launchRequest
        && datasetCreateRoute !== "build"
        && (modelsRoute?.kind !== "library" || modelsRoute.section === "projects")
      }
      onCreateDataset={openDatasetCreation}
      onCreateModel={() => setModelCreateOpen(true)}
    >
      {modelsRoute?.kind === "library" ? (
        modelsRoute.section === "projects" ? (
          <LabModelsPage
            activeProfileId={profileId}
            items={models}
            loading={training.training.loading && !models.length}
            providerSettings={training.providerSettings}
            runs={createImprove.runs}
            state={training.training.payload}
            onSelect={(key) => {
              const project = models.find((item) => item.key === key);
              if (project) navigateModelsRoute(modelProjectRoute(project.id));
            }}
            onUseModel={useModel}
          />
        ) : modelsRoute.section === "tasksets" ? (
          datasetCreateRoute === "build" ? (
            <TasksetDraftEditor
              defaultModel={training.defaultModel}
              draftId={datasetDraftId}
              modelProjectId={null}
              training={training.training}
              onBack={closeDatasetCreation}
              onOpenChat={openDatasetBuilderChat}
              onPublished={finishDatasetCreation}
            />
          ) : (
            <LabDatasetsPage
              defaultModel={training.defaultModel}
              detailTab={modelsRoute.detailTab as TasksetDetailTab | null}
              modelProjectId={null}
              runs={createImprove.runs}
              selectedId={modelsRoute.resourceId}
              state={training.training.payload}
              training={training.training}
              onDetailTabChange={(detailTab) => navigateModelsRoute(modelLibraryRoute(
                "tasksets",
                modelsRoute.resourceId,
                detailTab,
              ))}
              onImproveInChat={openDatasetBuilderChat}
              onCreateTaskset={openDatasetCreation}
              onOpenDraft={(draftId) => {
                setDatasetDraftId(draftId);
                setDatasetCreateRoute("build");
              }}
              onOpenFiles={(tasksetId) => {
                training.onSelectedTasksetIdChange(tasksetId);
                training.onOpenTasksetFiles();
              }}
              onSelectedIdChange={(tasksetId) => navigateModelsRoute(modelLibraryRoute(
                "tasksets",
                tasksetId,
              ))}
              onToast={(message, tone) => profileView.onToast?.(message, tone) ?? 0}
              onTrainModel={openModelRunEditor}
            />
          )
        ) : modelsRoute.section === "scoring" ? (
          <LabScoringPage
            busy={training.training.busyAction === "create-scorer"}
            defaultModel={training.defaultModel}
            onOpenTaskset={(tasksetId) => navigateModelsRoute(modelLibraryRoute("tasksets", tasksetId))}
            onCreateScorer={(input) => createScorer(input, null)}
            onSelectedScorerIdChange={(scorerId) => navigateModelsRoute(modelLibraryRoute("scoring", scorerId))}
            selectedScorerId={modelsRoute.resourceId}
            providerSettings={training.providerSettings}
            state={training.training.payload}
          />
        ) : modelsRoute.section === "evaluations" ? (
          <LabEvaluationsPage
            detailTab={modelsRoute.detailTab as EvaluationDetailTab | null}
            onDetailTabChange={(detailTab) => navigateModelsRoute(modelLibraryRoute(
              "evaluations",
              modelsRoute.resourceId,
              detailTab,
            ))}
            onSelectedEvaluationIdChange={(evaluationId) => navigateModelsRoute(modelLibraryRoute("evaluations", evaluationId))}
            selectedEvaluationId={modelsRoute.resourceId}
            state={training.training.payload}
          />
        ) : (
          <LabHumanReviewsPage
            defaultModel={training.defaultModel}
            onSelectedTasksetIdChange={(tasksetId) => navigateModelsRoute(modelLibraryRoute("reviews", tasksetId))}
            selectedTasksetId={modelsRoute.resourceId}
            state={training.training.payload}
            training={training.training}
          />
        )
      ) : activeTab === "tasksets" && training.launchRequest ? (
        renderLaunchEditor(selectedDatasetId)
      ) : activeTab === "tasksets" ? (
        datasetCreateRoute === "build" ? (
          <TasksetDraftEditor
            defaultModel={training.defaultModel}
            draftId={datasetDraftId}
            modelProjectId={selected?.id ?? null}
            training={training.training}
            onBack={closeDatasetCreation}
            onOpenChat={openDatasetBuilderChat}
            onPublished={finishDatasetCreation}
          />
        ) : (
          <LabDatasetsPage
            defaultModel={training.defaultModel}
            detailTab={
              modelsRoute?.kind === "project" && modelsRoute.section === "tasksets"
                ? modelsRoute.detailTab as TasksetDetailTab | null
                : null
            }
            runs={createImprove.runs}
            selectedId={selectedDatasetId}
            state={training.training.payload}
            training={training.training}
            onToast={(message, tone) =>
              profileView.onToast?.(message, tone) ?? 0
            }
            onSelectedIdChange={(tasksetId) => {
              if (!selectedProjectRouteId) {
                setSelectedDatasetId(tasksetId);
                return;
              }
              navigateModelsRoute({
                kind: "project",
                projectId: selectedProjectRouteId,
                section: "tasksets",
                resourceId: tasksetId,
                detailTab: null,
              });
            }}
            onDetailTabChange={(detailTab) => {
              if (!selectedProjectRouteId) return;
              navigateModelsRoute({
                kind: "project",
                projectId: selectedProjectRouteId,
                section: "tasksets",
                resourceId: selectedDatasetId,
                detailTab,
              });
            }}
            modelProjectId={selected?.id ?? null}
            onOpenDraft={(draftId) => {
              setDatasetDraftId(draftId);
              setDatasetCreateRoute("build");
            }}
            onImproveInChat={(taskset) => openDatasetBuilderChat(taskset)}
            onTrainModel={openModelRunEditor}
            onOpenFiles={(tasksetId) => {
              training.onSelectedTasksetIdChange(tasksetId);
              training.onOpenTasksetFiles();
            }}
          />
        )
      ) : activeTab === "scoring" && modelsRoute?.kind === "project" ? (
        <LabScoringPage
          busy={training.training.busyAction === "create-scorer"}
          defaultModel={training.defaultModel}
          modelProjectId={modelsRoute.projectId}
          onCreateScorer={(input) => createScorer(input, modelsRoute.projectId)}
          onOpenTaskset={(tasksetId) => navigateModelsRoute({
            kind: "project",
            projectId: modelsRoute.projectId,
            section: "tasksets",
            resourceId: tasksetId,
            detailTab: null,
          })}
          onSelectedScorerIdChange={(scorerId) => navigateModelsRoute({
            kind: "project",
            projectId: modelsRoute.projectId,
            section: "scoring",
            resourceId: scorerId,
            detailTab: null,
          })}
          selectedScorerId={modelsRoute.resourceId}
          providerSettings={training.providerSettings}
          state={training.training.payload}
        />
      ) : activeTab === "evals" && modelsRoute?.kind === "project" ? (
        <LabEvaluationsPage
          detailTab={modelsRoute.detailTab as EvaluationDetailTab | null}
          modelProjectId={modelsRoute.projectId}
          onDetailTabChange={(detailTab) => navigateModelsRoute({
            ...modelsRoute,
            detailTab,
          })}
          onSelectedEvaluationIdChange={(evaluationId) => navigateModelsRoute({
            kind: "project",
            projectId: modelsRoute.projectId,
            section: "evals",
            resourceId: evaluationId,
            detailTab: null,
          })}
          selectedEvaluationId={modelsRoute.resourceId}
          state={training.training.payload}
        />
      ) : activeTab === "serving" ? (
        <LabServingPage
          modelProjectId={selected?.id ?? selectedProjectRouteId}
          state={training.training.payload}
        />
      ) : training.launchRequest ? (
        renderLaunchEditor(null)
      ) : selected ? (
        <LabWorkproductDetail
          connection={profileView.connection}
          profile={profile}
          runs={createImprove.runs}
          training={training.training}
          workproduct={selected}
          modelSection={
            activeTab === "training" || activeTab === "versions"
              ? activeTab
              : "overview"
          }
          modelDetailTab={
            modelsRoute?.kind === "project" ? modelsRoute.detailTab : null
          }
          onModelDetailTabChange={(detailTab) => {
            if (modelsRoute?.kind !== "project" || !modelsRoute.resourceId) return;
            navigateModelsRoute({ ...modelsRoute, detailTab });
          }}
          selectedModelEntryKey={
            modelsRoute?.kind === "project" &&
            (modelsRoute.section === "runs" || modelsRoute.section === "versions")
              ? modelsRoute.resourceId
                ? modelEntryKeyFromRoute(modelsRoute.resourceId)
                : null
              : null
          }
          onSelectedModelEntryKeyChange={(entryKey) => {
            if (modelsRoute?.kind !== "project") return;
            navigateModelsRoute({
              ...modelsRoute,
              resourceId: modelEntryRouteId(entryKey),
              detailTab: null,
            });
          }}
          onAnswerQuestion={onAnswerQuestion}
          onApplyCandidate={onApplyCandidate}
          onApprove={onApprove}
          onCancel={onCancel}
          candidateReview={candidateReview}
          onCandidateReviewChange={onCandidateReviewChange}
          onChatWithModel={training.onChatWithModel}
          onOpenPullRequest={onOpenPullRequest}
          onOpenCandidateFiles={onOpenCandidateFiles}
          onOpenConversation={onOpenRunConversation}
          onClose={closeSelectedWorkproduct}
          onLocationChange={onDetailOpenChange}
          onRenameAgent={() => undefined}
          onOpenDataset={(tasksetId) => {
            if (selectedProjectRouteId) {
              navigateModelsRoute({
                kind: "project",
                projectId: selectedProjectRouteId,
                section: "tasksets",
                resourceId: tasksetId,
                detailTab: null,
              });
            }
          }}
          onPause={onPause}
          onReconcilePullRequest={onReconcilePullRequest}
          onRejectCandidate={onRejectCandidate}
          onResume={onResume}
          onRevise={onRevise}
          renderModelRunEditor={({
            initialTasksetId,
            modelId,
            modelName,
            onCancel: cancelBuild,
            onFinished: finishBuild,
            onSectionChange,
          }) => (
            <ModelRunEditorPage
              connection={profileView.connection}
              initialModelId={modelId}
              initialName={modelName}
              initialObjective={selected.description}
              initialTasksetId={initialTasksetId ?? undefined}
              profileId={profileId}
              training={training.training}
              onCancel={cancelBuild}
              onFinished={async () => {
                await createImprove.refresh();
                await finishBuild();
              }}
              onSectionChange={onSectionChange}
              onOpenProviderSettings={training.onOpenProviderSettings}
              renderDatasetBuilder={(onCreated, onUseExistingDataset) => (
                <TasksetDraftEditor
                  defaultModel={training.defaultModel}
                  modelProjectId={selected.id}
                  training={training.training}
                  onBack={onUseExistingDataset}
                  onOpenChat={openDatasetBuilderChat}
                  onPublished={onCreated}
                  onUseExistingTaskset={onUseExistingDataset}
                />
              )}
            />
          )}
          onStartAgentChange={() => undefined}
          onToast={training.onToast}
          benchmarkDefaultModel={training.defaultModel}
          benchmarkProviderSettings={training.providerSettings}
          initialBenchmarkModel={
            benchmarkLaunch?.modelId === selected.id
              ? benchmarkLaunch.model
              : null
          }
          initialBenchmarkOpen={benchmarkLaunch?.modelId === selected.id}
          onInitialBenchmarkOpenConsumed={() => setBenchmarkLaunch(null)}
        />
      ) : modelsRoute?.kind === "index" ? (
        <LabModelsOverviewPage
          items={models}
          state={training.training.payload}
          onOpenProject={(projectId) => navigateModelsRoute(modelProjectRoute(projectId))}
          onOpenRun={(run) => navigateModelsRoute({
            kind: "project",
            projectId: run.modelId,
            section: "runs",
            resourceId: modelEntryRouteId(`model-run:${run.id}`),
            detailTab: null,
          })}
          onOpenServing={(projectId) => navigateModelsRoute(modelProjectRoute(projectId, "serving"))}
        />
      ) : (
        <LabModelsPage
          activeProfileId={profileId}
          items={models}
          loading={training.training.loading && !models.length}
          providerSettings={training.providerSettings}
          runs={createImprove.runs}
          state={training.training.payload}
          onSelect={(key) => {
            const project = models.find((item) => item.key === key);
            if (project) navigateModelsRoute(modelProjectRoute(project.id));
          }}
          onUseModel={useModel}
        />
      )}

      {modelCreateOpen ? (
        <LabModelCreateDialog
          baseModelCandidates={
            training.training.payload?.baseModelCandidates ?? []
          }
          busy={training.training.busyAction === "save-model-project"}
          defaultBenchmarkModel={training.defaultModel}
          initialName={nextModelName(
            training.training.payload?.modelProjects ?? [],
          )}
          onClose={() => setModelCreateOpen(false)}
          onCreate={createModel}
          onManageModels={() => {
            setModelCreateOpen(false);
            training.onOpenTrainingSettings();
          }}
          providerSettings={training.providerSettings}
        />
      ) : null}
      {datasetCreateRoute === "source" ? (
        <DatasetSourcePickerDialog
          onClose={closeDatasetCreation}
          onSelect={async (source) => {
            if (source === "build") {
              const created = await training.training.actions.createTasksetDraft();
              if (!created) return;
              setDatasetDraftId(created.id);
              setDatasetCreateRoute("build");
              return;
            }
            setDatasetCreateRoute(source);
          }}
        />
      ) : null}
      {datasetCreateRoute === "huggingface" ? (
        <HuggingFaceDatasetImportDialog
          onBack={() => setDatasetCreateRoute("source")}
          onClose={closeDatasetCreation}
          onImported={async (tasksetId) => {
            await training.training.refresh();
            finishDatasetCreation(tasksetId);
          }}
          onOpenDatasetStorageSettings={() => {
            setDatasetCreateRoute(null);
            training.onOpenDatasetStorageSettings();
          }}
          training={training.training}
        />
      ) : null}
      <LabsRouteModelUseDialog
        versionId={modelUseVersionId}
        training={training}
        onClose={() => setModelUseVersionId(null)}
      />
    </LabsView>
  );
}
