import { createContext, useContext, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type { ExperimentDefinition } from "openpond-sdk/experiments";
import type { DatasetPopulationPage } from "openpond-sdk/dataset-workspaces";
import type { ModelsRoute } from "../models-route";
import type { SelectedDatasetGrader } from "./DatasetSetupGraders";
export type DatasetRelease = DatasetPopulationPage["release"];
export type ExperimentSetupDefinition=Pick<ExperimentDefinition,"id"|"request"|"graders"|"maximumCostUsd">&{packageHash?:string};
type TaskSelection = { release: DatasetRelease; mode: "all" | "subset"; ids: string[] };
export type ExperimentSetupMode = "model" | "model_harness" | "model_harness_profile";
export type ExperimentSetupDraft = { mode: ExperimentSetupMode; sourceId: string; profileChoiceId: string; temperature?:number; topP?:number; name: string; release: DatasetRelease | null; modelId: string; budget: number; outputTokens: number; prompt: string; targetId: string; seed: string; graderChoices: Record<string, SelectedDatasetGrader[]> };
const pin = (release: DatasetRelease | null) => release ? JSON.stringify([release.id, release.revision, release.contentHash]) : "";
function initialDraft(existing: ExperimentSetupDefinition | null, release: DatasetRelease | null, targetId: string): ExperimentSetupDraft {
  const policy=existing?.request.policy;
  const mode:ExperimentSetupMode=policy?.kind==="hosted_harness"?"model_harness_profile":policy?.kind==="hosted_chat"&&policy.harness?"model_harness":"model";
  return { mode, sourceId:policy?.kind==="hosted_chat"&&policy.harness?`harness-${policy.harness.harnessRelease.contentHash}`:"", profileChoiceId:"",
    ...(policy?.kind==="hosted_chat"?{temperature:policy.temperature,topP:policy.topP}:{}), name: existing?.request.name ?? "", release: existing?.request.taskset ?? release, modelId: existing && "modelId" in existing.request.policy ? existing.request.policy.modelId : "", budget: existing?.maximumCostUsd ?? 1, outputTokens: existing?.request.policy.kind === "hosted_chat" ? existing.request.policy.maxOutputTokens : 1024, prompt: existing?.request.policy.kind === "hosted_chat" ? existing.request.policy.messages?.find(message => message.role === "system")?.content ?? "" : "", targetId: existing?.request.project?.targetId ?? targetId, seed: existing ? [...new Set(existing.request.population.map(member => member.seed))].join(", ") : "0", graderChoices: {} };
}
type SetupState = { draft: ExperimentSetupDraft | null; setDraft: Dispatch<SetStateAction<ExperimentSetupDraft | null>>; existing: ExperimentSetupDefinition | null; changeRelease: (release: DatasetRelease | null) => void; baseline: string; reviewRoute: ModelsRoute | null; selection: TaskSelection | null; activate: (release: DatasetRelease) => void; selected: (release: DatasetRelease, id: string) => boolean; toggle: (release: DatasetRelease, id: string, checked: boolean) => void; selectAll: (release: DatasetRelease, all: boolean) => void; openSelection: (release: DatasetRelease, route: ModelsRoute) => void; count: (release: DatasetRelease, total: number) => number; open: (existing?: ExperimentSetupDefinition | null, release?: DatasetRelease | null, reviewRoute?: ModelsRoute | null, targetId?: string) => void; close: () => void };
const EvaluationSetupContext = createContext<SetupState | null>(null);
export function EvaluationSetupProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<ExperimentSetupDraft | null>(null);
  const [existing, setExisting] = useState<ExperimentSetupDefinition | null>(null);
  const [baseline, setBaseline] = useState("");
  const [reviewRoute, setReviewRoute] = useState<ModelsRoute | null>(null);
  const [selection, setSelection] = useState<TaskSelection | null>(null);
  const matches = (release: DatasetRelease) => pin(selection?.release ?? null) === pin(release);
  function activate(release: DatasetRelease) { setSelection(value => pin(value?.release ?? null) === pin(release) ? value : { release, mode: "all", ids: [] }); }
  function open(value: ExperimentSetupDefinition | null = null, release: DatasetRelease | null = null, route: ModelsRoute | null = null, targetId = "model") {
    if (draft && existing?.id === value?.id && (!release || pin(draft.release) === pin(release))) { if (route) setReviewRoute(route); return; }
    const next = initialDraft(value, release, targetId);
    setExisting(value); setDraft(next); setBaseline(JSON.stringify(next)); setReviewRoute(route);
    if (next.release) {
      if (value) setSelection({ release: next.release, mode: "subset", ids: [...new Set(value.request.population.map(task => task.taskId))] });
      else activate(next.release);
    }
  }
  const state: SetupState = { draft, setDraft, existing, changeRelease: release => { setDraft(value => value ? { ...value, release } : value); if (pin(draft?.release ?? null) !== pin(release)) setReviewRoute(null); if (release) activate(release); }, baseline, reviewRoute, selection, activate, open,
    // Checkbox edits preserve a same-release setup, including its original immutable configuration,
    // name, graders and model configuration. Switching releases starts a new draft.
    openSelection: (release, route) => { if (draft && pin(draft.release) === pin(release)) { setReviewRoute(route); return; } open(null, release, route); },
    close: () => { setDraft(null); setExisting(null); setReviewRoute(null); },
    selected: (release, id) => !matches(release) || selection!.mode === "all" ? !matches(release) || !selection!.ids.includes(id) : selection!.ids.includes(id),
    toggle: (release, id, checked) => setSelection(value => { const current = pin(value?.release ?? null) === pin(release) ? value! : { release, mode: "all" as const, ids: [] }; const add = current.mode === "all" ? !checked : checked; return { ...current, ids: add ? [...new Set([...current.ids, id])] : current.ids.filter(value => value !== id) }; }),
    selectAll: (release, all) => setSelection({ release, mode: all ? "all" : "subset", ids: [] }),
    count: (release, total) => !matches(release) ? total : selection!.mode === "all" ? Math.max(0, total - selection!.ids.length) : selection!.ids.length,
  };
  return <EvaluationSetupContext.Provider value={state}>{children}</EvaluationSetupContext.Provider>;
}
export function useEvaluationSetup() { const value = useContext(EvaluationSetupContext); if (!value) throw new Error("Evaluation setup requires workspace scope."); return value; }
