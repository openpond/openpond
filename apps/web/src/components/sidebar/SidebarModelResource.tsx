import { useId, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrainingNavigationResponse } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { createHostedModelLearningApi } from "../../api/model-learning-api";
import { MoreHorizontal, RefreshCw } from "../icons";
import { BaseModelIcon } from "../labs/BaseModelIcon";
import { HostedModelServeAction } from "../labs/HostedModelServingSetup";
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
};

export function SidebarModelResource({ model, activity, onOpen, onOpenRuns, children, ...controls }: SidebarModelControlsProps & {
  activity?: TrainingNavigationResponse["activityByProjectId"][string];
  onOpen(): void;
  onOpenRuns(key: string | null): void;
  children: ReactNode;
}) {
  const { name, baseModelId } = model;
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const gpu = activity?.activeRuns === 1 && activity.gpuType && activity.gpuCount
    ? `${activity.gpuCount} × ${activity.gpuType.replaceAll("_", " ")}` : null;
  return <SidebarResourceRow name={name} icon={<BaseModelIcon modelId={baseModelId} />} actions={<>
      <SidebarModelControls model={model} {...controls} />
      <button type="button" className="sidebar-icon" aria-label={`Actions for ${name}`} popoverTarget={menuId}>
        <MoreHorizontal size={15} aria-hidden="true" />
      </button>
      <div id={menuId} ref={menu} popover="auto" className="sidebar-model-menu" role="group" aria-label={`${name} actions`}>
        <button type="button" onClick={() => { menu.current?.hidePopover(); onOpen(); }}>Open model details</button>
        <button type="button" onClick={() => { menu.current?.hidePopover(); onOpenRuns(activity?.activeRuns === 1 ? activity.runKey : null); }}>
          {activity ? "Manage training run" : "View training runs"}
        </button>
      </div>
    </>} status={activity ? <button type="button" className="sidebar-model-activity training-text-button"
      onClick={() => onOpenRuns(activity.activeRuns === 1 ? activity.runKey : null)}>
      <LabStatusBadge label={activity.activeRuns > 1 ? `${activity.activeRuns} active runs` : activity.label} value={activity.status} />
      {gpu ? <span>{gpu}</span> : null}
    </button> : null}>{children}</SidebarResourceRow>;
}

export function SidebarModelControls({ model, connection, actorId, apiBaseUrl, activeTeamId, onOpenLearning }: SidebarModelControlsProps) {
  const { id, name, profileId, apiOrigin, teamId, hostedProjectId } = model;
  const workspace = useMemo(() => {
    if (!connection || !apiBaseUrl || !apiOrigin || !actorId || !teamId || teamId !== activeTeamId || !hostedProjectId ||
      !URL.canParse(apiBaseUrl) || new URL(apiBaseUrl).origin !== apiOrigin) return null;
    return createWorkspaceApi(connection, { actorId, teamId, accountKey: apiOrigin, projectId: null });
  }, [connection, apiBaseUrl, apiOrigin, actorId, teamId, activeTeamId, hostedProjectId]);
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
  return workspace && hostedProjectId ? <>
      <button type="button" className={`sidebar-icon${policy?.enabled ? " active" : ""}`}
        aria-label={learningLabel} title={learningLabel} onClick={onOpenLearning}>
        <RefreshCw size={14} aria-hidden="true" />
      </button>
      <HostedModelServeAction compact api={workspace} modelId={hostedProjectId} name={name} />
    </> : null;
}
