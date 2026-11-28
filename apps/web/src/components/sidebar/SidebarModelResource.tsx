import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TrainingNavigationResponse } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { createHostedModelLearningApi } from "../../api/model-learning-api";
import { ChevronDown, ChevronRight, RefreshCw } from "../icons";
import { HostedModelServeAction } from "../labs/HostedModelServingSetup";
import { LabStatusBadge } from "../labs/LabStatusBadge";
import { createWorkspaceApi } from "../labs/workspace/workspace-api";
import "./sidebar-model-resource.css";

export function SidebarModelResource({ model, activity, connection, actorId, apiBaseUrl, activeTeamId, onOpen, onOpenLearning, onOpenRuns, children }: {
  model: TrainingNavigationResponse["projects"][number];
  activity?: TrainingNavigationResponse["activityByProjectId"][string];
  connection: ClientConnection | null;
  actorId: string | null;
  apiBaseUrl: string | null;
  activeTeamId: string | null;
  onOpen(): void;
  onOpenLearning(): void;
  onOpenRuns(key: string | null): void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
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
  const learningLabel = policy?.enabled ? "Continual learning on" : "Continual learning paused";
  const gpu = activity?.activeRuns === 1 && activity.gpuType && activity.gpuCount
    ? `${activity.gpuCount} × ${activity.gpuType.replaceAll("_", " ")}` : null;
  return <div className="sidebar-model-resource">
    <div className="sidebar-model-row">
      {children ? <button type="button" className="sidebar-icon" aria-label={`${expanded ? "Collapse" : "Expand"} ${name} chats`}
        aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button> : null}
      <button type="button" className="sidebar-model-title" onClick={onOpen}>{name}</button>
      {policy ? <button type="button" className={`sidebar-icon${policy.enabled ? " active" : ""}`}
        aria-label={learningLabel} title={learningLabel} onClick={onOpenLearning}>
        <RefreshCw size={14} aria-hidden="true" />
      </button> : null}
      {workspace && hostedProjectId ? <HostedModelServeAction compact api={workspace} modelId={hostedProjectId} name={name} /> : null}
    </div>
    {activity ? <button type="button" className="sidebar-model-activity training-text-button"
      onClick={() => onOpenRuns(activity.activeRuns === 1 ? activity.runKey : null)}>
      <LabStatusBadge label={activity.activeRuns > 1 ? `${activity.activeRuns} active runs` : activity.label} value={activity.status} />
      {gpu ? <span>{gpu}</span> : null}
    </button> : null}
    {expanded && children ? <div className="sidebar-model-threads">{children}</div> : null}
  </div>;
}
