import { useCallback, type Dispatch, type SetStateAction } from "react";
import { PanelLeft } from "../icons";
import { DesktopUpdateButton } from "./DesktopUpdateButton";
import { DropdownSelect } from "../DropdownSelect";
import { useChatResourceIndex } from "../../hooks/useChatResourceIndex";
import {
  SidebarNavigation,
} from "./SidebarNavigation";
import { usePonderWork } from "../ponder/usePonderWork";
import { SidebarSectionList } from "./SidebarSectionList";
import { NativeConversationControls, useNativeConversationHistory } from "./NativeConversationSources";
import { OPENPOND_WORDMARK_WHITE_URL } from "../../lib/public-assets";
import type { SidebarProps } from "./Sidebar.types";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import type { SidebarSectionMenuId } from "../../app/app-state";

export function Sidebar(props: SidebarProps & { open?: boolean }) {
  const resources=useChatResourceIndex(props.productArea==="chat" ? props.connection : null);
  const filteredSessions=resources.sessionIds ? {
    activeSessions:props.activeSessions.filter(session=>resources.sessionIds!.has(session.id)),
    archivedSessions:props.archivedSessions.filter(session=>resources.sessionIds!.has(session.id)),
    childSessionRowsByParentId:Object.fromEntries(Object.entries(props.childSessionRowsByParentId ?? {}).map(([id,rows])=>[id,rows.filter(session=>resources.sessionIds!.has(session.id))])),
  } : {};

  const {
    productArea,
    setSectionMenuOpen,
    setSelectedAppId,
    setSelectedProjectId,
    setSelectedSessionId,
    setSidebarOpen,
    setView,
    view,
    modelProjects,
    modelTrainingActivityByProjectId,
  } = props;
  const setSidebarSectionMenuOpen = useCallback<
    Dispatch<SetStateAction<SidebarSectionMenuId | null>>
  >(
    (value) => {
      setSectionMenuOpen(value);
    },
    [setSectionMenuOpen],
  );

  const selectSession = useCallback(async (session: import("@openpond/contracts").Session) => {
    if (!await navigateDesktopRoute({ kind: "chat", sessionId: session.id })) return false;
    setSelectedSessionId(session.id);
    const projectId = props.sidebarProjectIdBySessionId[session.id] ?? null;
    setSelectedProjectId(projectId); setSelectedAppId(projectId ? null : session.appId);
    setView("chat"); return true;
  }, [setSelectedSessionId, setSelectedProjectId, setSelectedAppId, setView, props.sidebarProjectIdBySessionId]);
  const accountScopeKey = JSON.stringify({ account: props.account?.activeProfile ?? null, baseUrl: props.account?.baseUrl ?? null,
    owner: props.account?.profile?.id ?? null, state: props.account?.state ?? null, teamId: props.selectedTeamId ?? null });
  const ponderEnabled = productArea === "chat" && props.account?.state === "signed_in";
  const ponderWork = usePonderWork(props.connection, ponderEnabled, accountScopeKey);
  const localWorkflowGroups = ponderEnabled && ponderWork.data?.ownerScope ? ponderWork.data.localHandoffs.filter(item => item.workflow &&
    (["installationId", "profileId", "ownerUserId", "teamId"] as const).every(key => item.scope[key] === ponderWork.data!.ownerScope![key])) : [];
  const localWorkflowIds = new Set(localWorkflowGroups.flatMap(group => [group.prerequisite.sessionId,
    group.successor.sessionId, group.workflow?.preparationSessionId].filter((id): id is string => Boolean(id))));
  const localWorkflowSessions = (props.allSessions ?? [...props.activeSessions, ...props.archivedSessions]).filter(session => {
    const owner = session.metadata?.ponderLocalOwner;
    return localWorkflowIds.has(session.id) && owner !== null && typeof owner === "object" && !Array.isArray(owner) &&
      (["installationId", "profileId", "ownerUserId", "teamId"] as const).every(key =>
        (owner as Record<string, unknown>)[key] === ponderWork.data?.ownerScope?.[key]);
  });
  const nativeHistory = useNativeConversationHistory({ connection: productArea === "chat" ? props.connection : null, active: view === "chat", selectedSessionId: props.selectedSessionId, selectedSession: [...props.activeSessions, ...props.archivedSessions, ...Object.values(props.childSessionRowsByParentId ?? {}).flat()].find((session) => session.id === props.selectedSessionId) ?? null, onOpen: selectSession });

  return (
    <aside className="sidebar" inert={props.open === false}>
      <div className="sidebar-toolbar">
        <button
          className="sidebar-icon"
          aria-label="Hide sidebar"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeft size={16} />
        </button>
        <div className="sidebar-brand">
          <img className="sidebar-wordmark" src={OPENPOND_WORDMARK_WHITE_URL} alt="OpenPond" />
        </div>
        <DesktopUpdateButton hasRunningWork={props.runningSessionIds.size > 0 || Object.values(props.terminalSummaries).some((summary) => summary.tabCount > 0)} />
      </div>

      <div className="sidebar-scroll">
        {productArea !== "chat" ? <SidebarNavigation
          productArea={productArea}
          setSectionMenuOpen={setSidebarSectionMenuOpen}
          setSelectedAppId={setSelectedAppId}
          setSelectedProjectId={setSelectedProjectId}
          setSelectedSessionId={setSelectedSessionId}
          setView={setView}
          view={view}
          modelProjects={modelProjects}
          modelTrainingActivityByProjectId={modelTrainingActivityByProjectId}
        /> : null}

        {productArea==="chat" && view==="chat" && resources.resources.length ? <div className="sidebar-resource-filter"><DropdownSelect compact label="Chats using resource" value={resources.selected}
          options={[{value:"",label:"All resources"},...resources.resources.map(resource=>({value:resource.kind+":"+resource.id,label:resource.name,description:resource.kind+" · version "+resource.revision}))]}
          onChange={resources.setSelected} /></div> : null}
        {productArea !== "chat" || view !== "chat" ? null : (
          <SidebarSectionList
            {...props}
            {...filteredSessions}
            trainingSessionIds={resources.trainingSessionIds}
            workflowGroups={localWorkflowGroups}
            workflowSessions={localWorkflowSessions}
            onSelectSession={nativeHistory.select}
            setSectionMenuOpen={setSidebarSectionMenuOpen}
          />
        )}
        {productArea === "chat" && view === "chat" ? <NativeConversationControls history={nativeHistory} /> : null}
      </div>

    </aside>
  );
}
