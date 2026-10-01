import { useState } from "react";
import type { HumanReviewView } from "@openpond/evals/human-review";
import { AssignedExecutionSetup } from "./AssignedExecutionSetup";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ClientConnection } from "../../api";
import type { ModelsRoute } from "../labs/models-route";
import { createWorkspaceApi, type Inventory } from "../labs/workspace/workspace-api";
import { WorkspacePanelControls, type EvaluationSidebarControl } from "../labs/workspace/WorkspacePanel";
import { HumanInboxFrame } from "./HumanInboxFrame";
import { InboxWorkspace } from "./InboxWorkspace";

export function InboxRoute({ connection, teamId, actorId, route, onNavigate, onSidebarControl }: {
  connection: ClientConnection | null; teamId: string | null; actorId: string | null; route: ModelsRoute;
  onNavigate: (route: ModelsRoute) => void; onSidebarControl?: (control: EvaluationSidebarControl | null) => void;
}) {
  const scopeKey=JSON.stringify([connection?.serverUrl,teamId,actorId,route.executionLocation??"hosted"]);
  const [retainedAssignment,setAssignment] = useState<{scopeKey:string;review:HumanReviewView}|null>(null);
  const assignment=retainedAssignment?.scopeKey===scopeKey?retainedAssignment.review:null;
  const api = connection && teamId && actorId ? createWorkspaceApi(connection, { teamId, actorId, projectId: null, accountKey: actorId }) : null;
  const projects = useInfiniteQuery({
    queryKey: ["human-inbox-projects", api?.key], enabled: Boolean(api),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => api!.request<Inventory["projects"]>("projects", pageParam ? { cursor: pageParam } : {}, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  if (!connection || !teamId || !actorId) return <p role="status">Sign in and select a workspace to open Inbox.</p>;
  return <WorkspacePanelControls onControl={onSidebarControl}><HumanInboxFrame>
    {projects.error ? <p role="alert">{projects.error.message}</p> : null}
    <InboxWorkspace context={{ connection, scope: teamId, actorId, location: route.executionLocation ?? "hosted" }}
      projects={projects.data?.pages.flatMap(page => page.projects).filter(project => !project.archived).map(project => ({ id: project.id, name: project.content.name }))}
      projectId={route.projectId} onProjectChange={projectId => onNavigate({ ...route, projectId, resourceId: null })}
      onConfigureExecution={review=>setAssignment({scopeKey,review})} onOpenExecution={id=>onNavigate({...route,page:"experiments",resourceId:id,detailTab:"cases"})}
      selectedId={route.resourceId} onSelection={id => { if (id !== route.resourceId) onNavigate({ ...route, resourceId: id }); }} />
    {assignment ? <AssignedExecutionSetup key={`${teamId}:${actorId}:${assignment.id}:${assignment.generation}`} context={{connection,scope:teamId,actorId,location:route.executionLocation??"hosted"}} review={assignment} route={route} onNavigate={onNavigate} onClose={()=>setAssignment(null)}/> : null}
    {projects.hasNextPage ? <button disabled={projects.isFetchingNextPage} onClick={() => void projects.fetchNextPage()}>More Projects</button> : null}
  </HumanInboxFrame></WorkspacePanelControls>;
}
