import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrainingNavigationResponse } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { createHostedModelLearningApi } from "../../api/model-learning-api";
import { Boxes, MoreHorizontal, RadioTower, RefreshCw } from "../icons";
import { BaseModelIcon } from "../labs/BaseModelIcon";
import { HostedModelServingSetup } from "../labs/HostedModelServingSetup";
import { ModelServingDialog } from "../labs/ModelServingDialog";
import { useHostedModelManaging } from "../labs/HostedModelServingStatus";
import { LabStatusBadge } from "../labs/LabStatusBadge";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import { SidebarResourceRow } from "./SidebarResourceRow";

type SidebarModelControlsProps = {
  model: TrainingNavigationResponse["projects"][number];
  connection: ClientConnection | null;
  actorId: string | null;
  apiBaseUrl: string | null;
  activeTeamId: string | null;
  onOpenLearning(): void;
  onOpenVersions(): void;
};

export function SidebarModelResource({ model, activity, onOpen, onOpenRuns, onActivate, onToggle, selected, children, ...controls }: SidebarModelControlsProps & {
  activity?: TrainingNavigationResponse["activityByProjectId"][string];
  onOpen(): void;
  onOpenRuns(key: string | null): void;
  onToggle(expanded: boolean): void;
  onActivate(): void;
  selected: boolean;
  children: ReactNode;
}) {
  const { name, baseModelId } = model;
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const { workspace, serveLabel, openServe, dialog } = useSidebarModelServing({ model, ...controls });
  const gpu = activity?.activeRuns === 1 && activity.gpuType && activity.gpuCount
    ? `${activity.gpuCount} × ${activity.gpuType.replaceAll("_", " ")}` : null;
  return <><SidebarResourceRow name={name} selected={selected} onActivate={onActivate} onToggle={onToggle}
    icon={<BaseModelIcon modelId={baseModelId} fallback={<Boxes size={15} />} />}
    leadingActions={<SidebarModelLearning model={model} workspace={workspace} onOpenLearning={controls.onOpenLearning} />} actions={<>
      <SidebarModelServeButton label={serveLabel} name={name} onClick={openServe} />
      <button type="button" className="sidebar-row-action" aria-label={`Actions for ${name}`} title="More actions" popoverTarget={menuId}>
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      <div id={menuId} ref={menu} popover="auto" className="sidebar-model-menu" role="group" aria-label={`${name} actions`}>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { menu.current?.hidePopover(); openServe(); }}>{serveLabel}</button>
        <button type="button" onClick={() => { menu.current?.hidePopover(); onOpen(); }}>Open model details</button>
        <button type="button" onClick={() => { menu.current?.hidePopover(); onOpenRuns(activity?.activeRuns === 1 ? activity.runKey : null); }}>
          {activity ? "Manage training run" : "View training runs"}
        </button>
      </div>
    </>} status={activity ? <button type="button" className="sidebar-model-activity training-text-button"
      onClick={() => onOpenRuns(activity.activeRuns === 1 ? activity.runKey : null)}>
      <LabStatusBadge label={activity.activeRuns > 1 ? `${activity.activeRuns} active runs` : activity.label} value={activity.status} />
      {gpu ? <span>{gpu}</span> : null}
    </button> : null}>{children}</SidebarResourceRow>{dialog}</>;
}

function useSidebarModelServing({ model, connection, actorId, apiBaseUrl, activeTeamId, onOpenVersions }: SidebarModelControlsProps) {
  const { name, apiOrigin, teamId, hostedProjectId } = model;
  const [serving, setServing] = useState(false);
  const workspace = useMemo(() => {
    if (!connection || !apiBaseUrl || !apiOrigin || !actorId || !teamId || teamId !== activeTeamId || !hostedProjectId ||
      !URL.canParse(apiBaseUrl) || new URL(apiBaseUrl).origin !== apiOrigin) return null;
    return createWorkspaceApi(connection, { actorId, teamId, accountKey: apiOrigin, projectId: null });
  }, [connection, apiBaseUrl, apiOrigin, actorId, teamId, activeTeamId, hostedProjectId]);
  const serveLabel = useHostedModelManaging(workspace, hostedProjectId ?? "") ? "Manage" : "Serve";
  const close = () => setServing(false);
  const dialog = !serving ? null : workspace && hostedProjectId
    ? <HostedModelServingSetup api={workspace} modelId={hostedProjectId} name={name} onClose={close} />
    : <ModelServingDialog ariaLabel={`Serve ${name}`} onClose={close}>
        <h2>Serve {name}</h2>
        <p>Choose a saved version to review serving options.</p>
        <button type="button" className="training-button" onClick={() => { close(); onOpenVersions(); }}>View versions</button>
      </ModelServingDialog>;
  return { workspace, serveLabel, openServe: () => setServing(true), dialog };
}

function SidebarModelLearning({ model, workspace, onOpenLearning }: Pick<SidebarModelControlsProps, "model" | "onOpenLearning"> & {
  workspace: ReturnType<typeof createWorkspaceApi> | null;
}) {
  const { id, profileId = "default" } = model;
  const learning = useQuery({
    queryKey: ["sidebar-model-learning", workspace?.key, profileId, id],
    enabled: Boolean(workspace),
    queryFn: () => createHostedModelLearningApi(workspace!.connection, id, profileId).overview(),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const policy = learning.data?.policy;
  const learningLabel = policy ? (policy.enabled ? "Continual learning on" : "Continual learning paused") : "Continual learning";
  return workspace ? <button type="button" className={`sidebar-row-action${policy?.enabled ? " active" : ""}`}
    aria-label={learningLabel} title={learningLabel} onClick={onOpenLearning}>
    <RefreshCw size={14} aria-hidden="true" />
  </button> : null;
}

export function SidebarModelControls(props: SidebarModelControlsProps) {
  const { workspace, serveLabel, openServe, dialog } = useSidebarModelServing(props);
  return <>
    <SidebarModelLearning model={props.model} workspace={workspace} onOpenLearning={props.onOpenLearning} />
    <SidebarModelServeButton label={serveLabel} name={props.model.name} onClick={openServe} />
    {dialog}
  </>;
}

function SidebarModelServeButton({ label, name, onClick }: { label: string; name: string; onClick(): void }) {
  return <button type="button" className="sidebar-row-action" aria-label={`${label} ${name}`} title={label} onClick={onClick}>
    <RadioTower size={15} aria-hidden="true" />
  </button>;
}
