import { canonicalJson, ExperimentDraftSchema } from "openpond-sdk/training";
import type {
  ExperimentDraft,
  ExperimentDraftRecord,
  ExperimentStartingModel,
  EvaluationExperimentFormDraft,
  EvaluationExperimentSelection,
  EvaluationExperimentSource,
  TrainingExperimentSetupRequest,
} from "openpond-sdk/training";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import {
  initialExperimentStartingModel,
  experimentModelSourceKey,
} from "./experiment-starting-model";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ModelsRoute } from "../models-route";
export type DatasetRelease = DatasetPopulationPage["release"];
export type ExperimentSetupDefinition = EvaluationExperimentSource;
type TaskSelection = EvaluationExperimentSelection;
export type ExperimentSetupMode = EvaluationExperimentFormDraft["mode"];
export type ExperimentSetupDraft = EvaluationExperimentFormDraft;
const pin = (release: DatasetRelease | null) =>
  release ? canonicalJson([release.id, release.revision, release.contentHash]) : "";
function initialDraft(
  existing: ExperimentSetupDefinition | null,
  release: DatasetRelease | null,
  targetId: string,
): ExperimentSetupDraft {
  const policy = existing?.request.policy;
  const mode: ExperimentSetupMode =
    policy?.kind === "hosted_harness"
      ? "model_harness_profile"
      : policy?.kind === "hosted_chat" && policy.harness
        ? "model_harness"
        : "model";
  return {
    mode,
    sourceId:
      policy?.kind === "hosted_chat" && policy.harness
        ? `harness-${policy.harness.harnessRelease.contentHash}`
        : "",
    profileChoiceId: "",
    ...(policy?.kind === "hosted_chat"
      ? { temperature: policy.temperature, topP: policy.topP, localRuntime: policy.localRuntime }
      : {}),
    name: existing?.request.name ?? "Evaluation",
    release: existing?.request.taskset ?? release,
    modelId:
      existing && "modelId" in existing.request.policy ? existing.request.policy.modelId : "",
    budget: existing?.maximumCostUsd ?? 1,
    outputTokens:
      existing?.request.policy.kind === "hosted_chat"
        ? existing.request.policy.maxOutputTokens
        : 1024,
    prompt:
      existing?.request.policy.kind === "hosted_chat"
        ? (existing.request.policy.messages?.find((message) => message.role === "system")
            ?.content ?? "")
        : "",
    targetId: existing?.request.project?.targetId ?? targetId,
    seed: existing
      ? [...new Set(existing.request.population.map((member) => member.seed))].join(", ")
      : "0",
    graderChoices: {},
  };
}
export type AdvancedExperimentTarget = {
  kind: "refiner_evaluation";
  evidence: { id: string; contentHash: string };
};
export type { ExperimentOperationType } from "openpond-sdk/training";
type ExperimentOperationType = ExperimentDraft["operationType"];
type SetupTransitionGuard = (action: () => void) => Promise<void>;
type TrainingParent = NonNullable<TrainingExperimentSetupRequest["parent"]>;
type SetupState = {
  startingModel: ExperimentStartingModel | null;
  chooseInferenceModel: (
    value: {
      id: string;
      name: string;
      baseModel?: TrainingExperimentSetupRequest["baseModel"] | null;
    } | null,
  ) => void;
  applyModelCatalogLink: (
    sourceKey: string,
    link: {
      baseModel: TrainingExperimentSetupRequest["baseModel"] | null;
      inferenceModelId: string | null;
    },
  ) => void;
  trainingParent: TrainingParent | null;
  setTrainingParent: (parent: TrainingParent | null) => void;
  registerTransitionGuard: (guard: SetupTransitionGuard) => () => void;
  requestSelection: (
    release: DatasetRelease,
    route: ModelsRoute,
    action?: { id: string; checked: boolean } | { all: boolean },
  ) => Promise<boolean>;
  storedRecord: ExperimentDraftRecord | null;
  openDraft: (draft: ExperimentDraft, route: ModelsRoute) => Promise<void>;
  openStored: (record: ExperimentDraftRecord, route: ModelsRoute) => void;
  acceptSaved: (record: ExperimentDraftRecord) => void;
  evaluationDirty: boolean;
  initialExperiment: ExperimentDraft | null;
  allowedOperationTypes: readonly ExperimentOperationType[];
  operationDraftDirty: boolean;
  reportOperationDraftDirty: (
    method: Exclude<ExperimentOperationType, "evaluate">,
    dirty: boolean,
  ) => void;
  operationType: ExperimentOperationType;
  setOperationType: (value: ExperimentOperationType) => void;
  trainingBaseModel: TrainingExperimentSetupRequest["baseModel"] | null;
  setTrainingBaseModel: (
    value: TrainingExperimentSetupRequest["baseModel"] | null,
    label?: string,
  ) => void;
  advancedTarget: AdvancedExperimentTarget | null;
  openAdvanced: (target: AdvancedExperimentTarget) => void;
  draft: ExperimentSetupDraft | null;
  setDraft: Dispatch<SetStateAction<ExperimentSetupDraft | null>>;
  existing: ExperimentSetupDefinition | null;
  changeRelease: (release: DatasetRelease | null) => void;
  baseline: string;
  reviewRoute: ModelsRoute | null;
  selection: TaskSelection | null;
  activate: (release: DatasetRelease) => void;
  selected: (release: DatasetRelease, id: string) => boolean;
  toggle: (release: DatasetRelease, id: string, checked: boolean) => void;
  selectAll: (release: DatasetRelease, all: boolean) => void;
  openSelection: (release: DatasetRelease, route: ModelsRoute) => void;
  count: (release: DatasetRelease, total: number) => number;
  open: (
    existing?: ExperimentSetupDefinition | null,
    release?: DatasetRelease | null,
    reviewRoute?: ModelsRoute | null,
    targetId?: string,
  ) => void;
  close: () => void;
};
const EvaluationSetupContext = createContext<SetupState | null>(null);
export function EvaluationSetupProvider({
  children,
  initialExperiment = null,
  initialRecord = null,
  onNewDraft,
  allowedOperationTypes = [
    "evaluate",
    "sft",
    "grpo",
    "neuron_steering",
    "inspect_activations",
    "engram_adapter",
    "decision_model",
    "alphaedit",
    "selective_neuron_training",
  ],
}: {
  children: ReactNode;
  onNewDraft?: (draft: ExperimentDraft) => Promise<void>;
  initialExperiment?: ExperimentDraft | null;
  initialRecord?: ExperimentDraftRecord | null;
  allowedOperationTypes?: readonly ExperimentOperationType[];
}) {
  const transitionGuard = useRef<SetupTransitionGuard | null>(null);
  const registerTransitionGuard = useCallback((guard: SetupTransitionGuard) => {
    transitionGuard.current = guard;
    return () => {
      if (transitionGuard.current === guard) transitionGuard.current = null;
    };
  }, []);
  const [authoring, setAuthoring] = useState(initialExperiment);
  const [storedRecord, setStoredRecord] = useState<ExperimentDraftRecord | null>(initialRecord);
  const [trainingDirty, setTrainingDirty] = useState<
    Partial<Record<Exclude<ExperimentOperationType, "evaluate">, boolean>>
  >({});
  const reportOperationDraftDirty = useCallback(
    (method: Exclude<ExperimentOperationType, "evaluate">, dirty: boolean) =>
      setTrainingDirty((previous) =>
        previous[method] === dirty ? previous : { ...previous, [method]: dirty },
      ),
    [],
  );
  const [operationType, setOperationTypeState] = useState<ExperimentOperationType>(
    initialExperiment?.operationType ?? "evaluate",
  );
  const [startingModel, setStartingModel] = useState(() =>
    initialExperimentStartingModel(initialExperiment),
  );
  const startingModelRef = useRef(startingModel);
  startingModelRef.current = startingModel;
  function setOperationType(value: ExperimentOperationType) {
    if (startingModelRef.current?.source === "alphaedit" && value !== "alphaedit") return;
    if (startingModelRef.current?.source === "neuron_training") return;
    if (startingModelRef.current?.source === "decision" && value !== "decision_model") return;
    if (startingModelRef.current?.source === "engram" && value !== "engram_adapter") return;
    if (startingModelRef.current?.source === "steering" && value !== "neuron_steering") return;
    setOperationTypeState(value);
  }
  const [trainingBaseModel, setTrainingBaseModelState] = useState<
    TrainingExperimentSetupRequest["baseModel"] | null
  >(() => {
    const selected = initialExperimentStartingModel(initialExperiment);
    return selected?.baseModel ?? null;
  });
  const [trainingParent, setTrainingParent] = useState<TrainingParent | null>(
    initialExperiment?.trainingForm?.parent ?? null,
  );
  const [advancedTarget, setAdvancedTarget] = useState<AdvancedExperimentTarget | null>(null);
  const [draft, setDraft] = useState<ExperimentSetupDraft | null>(() => {
    const form =
      initialExperiment?.evaluationForm?.form ??
      (initialExperiment ? initialDraft(null, null, "model") : null);
    const selected = initialExperimentStartingModel(initialExperiment);
    return form && selected
      ? {
          ...form,
          modelId: selected.source === "inference" ? selected.inferenceModelId! : "",
          localRuntime: selected.source !== "inference" ? undefined : form.localRuntime,
        }
      : form;
  });
  function setTrainingBaseModel(
    value: TrainingExperimentSetupRequest["baseModel"] | null,
    label?: string,
  ) {
    setTrainingBaseModelState(value);
    setTrainingParent(null);
    setStartingModel((previous) =>
      value
        ? {
            source: "managed",
            baseModel: value,
            inferenceModelId: null,
            label:
              label ??
              (previous?.source === "managed" &&
              canonicalJson(previous.baseModel) === canonicalJson(value)
                ? previous.label
                : value.modelId),
          }
        : null,
    );
    setDraft((previous) =>
      previous ? { ...previous, modelId: "", localRuntime: undefined } : previous,
    );
  }
  function chooseInferenceModel(
    value: {
      id: string;
      name: string;
      baseModel?: TrainingExperimentSetupRequest["baseModel"] | null;
    } | null,
  ) {
    setStartingModel(
      value
        ? {
            source: "inference",
            label: value.name,
            inferenceModelId: value.id,
            baseModel: value.baseModel ?? null,
          }
        : null,
    );
    setTrainingBaseModelState(value?.baseModel ?? null);
    setTrainingParent(null);
    setDraft((previous) =>
      previous ? { ...previous, modelId: value?.id ?? "", localRuntime: undefined } : previous,
    );
  }
  const applyModelCatalogLink = useCallback(
    (
      sourceKey: string,
      link: {
        baseModel: TrainingExperimentSetupRequest["baseModel"] | null;
        inferenceModelId: string | null;
      },
    ) => {
      const selected = startingModelRef.current;
      if (!selected || experimentModelSourceKey(selected) !== sourceKey) return;
      if (
        selected.source === "trained" ||
        selected.source === "steering" ||
        selected.source === "engram" ||
        selected.source === "decision" ||
        selected.source === "alphaedit" ||
        selected.source === "neuron_training"
      )
        return;
      const baseModel = selected.baseModel ?? link.baseModel;
      setTrainingBaseModelState((previous) =>
        canonicalJson(previous) === canonicalJson(baseModel) ? previous : baseModel,
      );
      setDraft((previous) =>
        previous && (previous.modelId !== (link.inferenceModelId ?? "") || previous.localRuntime)
          ? { ...previous, modelId: link.inferenceModelId ?? "", localRuntime: undefined }
          : previous,
      );
      if (selected.source === "inference") {
        setStartingModel((previous) =>
          previous &&
          previous.source === "inference" &&
          experimentModelSourceKey(previous) === sourceKey &&
          canonicalJson(previous.baseModel) !== canonicalJson(baseModel)
            ? { ...previous, baseModel }
            : previous,
        );
      } else {
        setStartingModel((previous) =>
          previous &&
          previous.source === "managed" &&
          experimentModelSourceKey(previous) === sourceKey &&
          previous.inferenceModelId !== link.inferenceModelId
            ? { ...previous, inferenceModelId: link.inferenceModelId }
            : previous,
        );
      }
    },
    [],
  );
  const [existing, setExisting] = useState<ExperimentSetupDefinition | null>(
    initialExperiment?.evaluationForm?.source ?? null,
  );
  const [baseline, setBaseline] = useState(() =>
    initialExperiment
      ? canonicalJson({
          draft: initialExperiment.evaluationForm?.form ?? initialDraft(null, null, "model"),
          selection: initialExperiment.evaluationForm?.selection ?? null,
        })
      : "",
  );
  const [reviewRoute, setReviewRoute] = useState<ModelsRoute | null>(null);
  const [selection, setSelection] = useState<TaskSelection | null>(
    initialExperiment?.evaluationForm?.selection ?? null,
  );
  const matches = (release: DatasetRelease) => pin(selection?.release ?? null) === pin(release);
  function activate(release: DatasetRelease) {
    setSelection((value) =>
      pin(value?.release ?? null) === pin(release) ? value : { release, mode: "all", ids: [] },
    );
  }
  function open(
    value: ExperimentSetupDefinition | null = null,
    release: DatasetRelease | null = null,
    route: ModelsRoute | null = null,
    targetId = "model",
  ) {
    if (draft && existing?.id === value?.id && (!release || pin(draft.release) === pin(release))) {
      if (route) setReviewRoute(route);
      return;
    }
    setAdvancedTarget(null);
    setAuthoring({
      schemaVersion: "openpond.experimentDraft.v1",
      id: crypto.randomUUID(),
      operationType: "evaluate",
      name: "Evaluation",
    });
    setStoredRecord(null);
    setTrainingDirty({});
    setTrainingBaseModelState(null);
    setStartingModel(null);
    setTrainingParent(null);
    setOperationType("evaluate");
    const next = initialDraft(value, release, targetId);
    const nextSelection: TaskSelection | null = next.release
      ? {
          release: next.release,
          mode: value ? "subset" : "all",
          ids: value ? [...new Set(value.request.population.map((task) => task.taskId))] : [],
        }
      : null;
    setExisting(value);
    setDraft(next);
    setSelection(nextSelection);
    setStartingModel(
      next.modelId
        ? {
            source: "inference",
            label: next.modelId,
            inferenceModelId: next.modelId,
            baseModel: null,
          }
        : null,
    );
    setBaseline(canonicalJson({ draft: next, selection: nextSelection }));
    setReviewRoute(route);
  }
  function applyDraft(
    saved: ExperimentDraft,
    record: ExperimentDraftRecord | null,
    route: ModelsRoute,
  ) {
    const evaluation = saved.evaluationForm;
    const selectedModel = initialExperimentStartingModel(saved);
    const savedForm = evaluation?.form ?? initialDraft(null, null, "model");
    const next = selectedModel
      ? {
          ...savedForm,
          modelId: selectedModel.source === "inference" ? selectedModel.inferenceModelId! : "",
          localRuntime: selectedModel.source !== "inference" ? undefined : savedForm.localRuntime,
        }
      : savedForm;
    setStartingModel(selectedModel);
    setAuthoring(saved);
    setStoredRecord(record);
    setAdvancedTarget(null);
    setTrainingDirty({});
    setOperationTypeState(saved.operationType);
    setTrainingParent(saved.trainingForm?.parent ?? null);
    setTrainingBaseModelState(selectedModel?.baseModel ?? null);
    setDraft(next);
    setExisting(evaluation?.source ?? null);
    setSelection(evaluation?.selection ?? null);
    setBaseline(canonicalJson({ draft: next, selection: evaluation?.selection ?? null }));
    setReviewRoute({ ...route, executionLocation: evaluation?.executionLocation ?? "hosted" });
  }
  function openStored(record: ExperimentDraftRecord, route: ModelsRoute) {
    applyDraft(record.draft, record, route);
  }
  async function openDraft(draft: ExperimentDraft, route: ModelsRoute) {
    const saved = ExperimentDraftSchema.parse(draft);
    let opening: Promise<void> | undefined;
    const apply = () => {
      if (onNewDraft) opening = onNewDraft(saved);
      else applyDraft(saved, null, route);
    };
    if (transitionGuard.current) await transitionGuard.current(apply);
    else apply();
    await opening;
  }
  function acceptSaved(record: ExperimentDraftRecord) {
    if (authoring?.id !== record.id) return;
    setStoredRecord(record);
    if (record.draft.evaluationForm)
      setBaseline(
        canonicalJson({
          draft: record.draft.evaluationForm.form,
          selection: record.draft.evaluationForm.selection,
        }),
      );
  }
  function openSelection(release: DatasetRelease, route: ModelsRoute) {
    if (draft && pin(draft.release) === pin(release)) {
      setOperationType("evaluate");
      setReviewRoute(route);
      return;
    }
    open(null, release, route);
  }
  async function requestSelection(
    release: DatasetRelease,
    route: ModelsRoute,
    action?: { id: string; checked: boolean } | { all: boolean },
  ) {
    let applied = false;
    const apply = () => {
      applied = true;
      openSelection(release, route);
      // Apply the click after opening, so initialization cannot overwrite it.
      if (action && "all" in action) state.selectAll(release, action.all);
      else if (action) state.toggle(release, action.id, action.checked);
    };
    if (draft && pin(draft.release) !== pin(release) && transitionGuard.current)
      await transitionGuard.current(apply);
    else apply();
    return applied;
  }
  const state: SetupState = {
    startingModel,
    chooseInferenceModel,
    applyModelCatalogLink,
    trainingParent,
    setTrainingParent,
    registerTransitionGuard,
    requestSelection,
    storedRecord,
    openDraft,
    openStored,
    acceptSaved,
    evaluationDirty: canonicalJson({ draft, selection }) !== baseline,
    initialExperiment: authoring,
    allowedOperationTypes,
    operationDraftDirty: Object.values(trainingDirty).some(Boolean),
    reportOperationDraftDirty,
    operationType,
    setOperationType,
    trainingBaseModel,
    setTrainingBaseModel,
    advancedTarget,
    openAdvanced: (target) => {
      setAdvancedTarget(target);
      setDraft(null);
      setExisting(null);
      setReviewRoute(null);
    },
    draft,
    setDraft,
    existing,
    changeRelease: (release) => {
      setDraft((value) => (value ? { ...value, release } : value));
      if (pin(draft?.release ?? null) !== pin(release)) setReviewRoute(null);
      if (release) activate(release);
    },
    baseline,
    reviewRoute,
    selection,
    activate,
    open,
    // Checkbox edits preserve a same-release setup, including its original immutable configuration,
    // name, graders and model configuration. Switching releases starts a new draft.
    openSelection,
    close: () => {
      setAuthoring(null);
      setStoredRecord(null);
      setTrainingDirty({});
      setTrainingBaseModelState(null);
      setStartingModel(null);
      setTrainingParent(null);
      setAdvancedTarget(null);
      setDraft(null);
      setExisting(null);
      setReviewRoute(null);
    },
    selected: (release, id) =>
      !matches(release) || selection!.mode === "all"
        ? !matches(release) || !selection!.ids.includes(id)
        : selection!.ids.includes(id),
    toggle: (release, id, checked) =>
      setSelection((value) => {
        const current =
          pin(value?.release ?? null) === pin(release)
            ? value!
            : { release, mode: "all" as const, ids: [] };
        const add = current.mode === "all" ? !checked : checked;
        return {
          ...current,
          ids: add
            ? [...new Set([...current.ids, id])]
            : current.ids.filter((value) => value !== id),
        };
      }),
    selectAll: (release, all) => setSelection({ release, mode: all ? "all" : "subset", ids: [] }),
    count: (release, total) =>
      !matches(release)
        ? total
        : selection!.mode === "all"
          ? Math.max(0, total - selection!.ids.length)
          : selection!.ids.length,
  };
  return (
    <EvaluationSetupContext.Provider value={state}>{children}</EvaluationSetupContext.Provider>
  );
}
export function useEvaluationSetup() {
  const value = useContext(EvaluationSetupContext);
  if (!value) throw new Error("Evaluation setup requires workspace scope.");
  return value;
}
