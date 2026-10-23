import { HostedSandboxesSetting } from "./HostedSandboxesSetting";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatAttachment, ChatProvider, ContextCompactionPreferences } from "@openpond/contracts";
import { apiFetch } from "../../api/api-client";
import { sessionApi } from "../../api/session-api";
import { localPonderError } from "./local-ponder-error";
import { useErrorToast } from "../../app/AppToastContext";
import { useTaskInbox } from "../../hooks/useTaskInbox";
import { connectionQueryScope } from "../../lib/query-scope";
import { contextWindowStatusFromUsage, latestContextUsageFromEvents } from "../../lib/context-window";
import { modelOptionsForProvider } from "../../lib/app-models";
import { DropdownSelect } from "../DropdownSelect";
import { Composer } from "../chat/Composer";
import { ConversationSurface } from "../chat/ConversationSurface";
import type { MainChatThread } from "../app-shell/MainChatThread";
import { X } from "../icons";
import { PonderHostedPanel } from "./PonderHostedPanel";
import { PonderConnections } from "./PonderConnections";
import { PonderSetupDialog } from "./PonderSetupDialog";
import { usePonderSession } from "./usePonderSession";
import type { LocalPonderState } from "./ponder-local-types";
import "./ponder-local.css";

type Props = ComponentProps<typeof PonderHostedPanel> & { contextCompaction: ContextCompactionPreferences; onOpenAgents(sessionId?:string):void;
  messageContext?: Pick<ComponentProps<typeof MainChatThread>, "accountBaseUrl" | "activeWorkspaceAppId" | "billingOrganizationSlug" | "billingTeamId" |
    "onOpenBrowserLink" | "onOpenAttachmentInSidebar" | "onOpenFileInSidebar" | "onOpenProfileSettings" | "workspaceRootPath">;
};
export function PonderDesktopPanel(props: Props) {
  const {connection: incomingConnection, composer} = props;
  const connection = useMemo(() => incomingConnection, [incomingConnection.serverUrl, incomingConnection.token, incomingConnection.platform, incomingConnection.arch]);
  const operationScope = JSON.stringify([connectionQueryScope(connection), props.accountScopeKey]);
  const activeScope = useRef(operationScope); activeScope.current = operationScope;
  const queries = useQueryClient();
  const localKey = ["ponder-local", connectionQueryScope(connection), props.accountScopeKey] as const;
  const snapshotKey = [...localKey,"snapshot"] as const;
  const snapshotQuery = useQuery({queryKey:snapshotKey,staleTime:30000,
    queryFn:()=>apiFetch<LocalPonderState>(connection,"/v1/ponder/local?catalog=0")});
  const localQuery = useQuery({queryKey:localKey, staleTime:30000,
    queryFn:() => apiFetch<LocalPonderState>(connection, "/v1/ponder/local")});
  const snapshot=snapshotQuery.data;
  const local = useMemo(()=>snapshot && (!localQuery.data || snapshot.coordinator.revision > localQuery.data.coordinator.revision)
    ? {...snapshot,supportedModelRefs:localQuery.data?.supportedModelRefs??[]} : localQuery.data ?? null,[snapshot,localQuery.data]);
  function setLocal(value:LocalPonderState) {queries.setQueryData(localKey,value);queries.setQueryData(snapshotKey,value);}
  useErrorToast(localQuery.error?.message ?? null);
  useErrorToast(snapshotQuery.error?.message ?? null);
  const [hosted, setHosted] = useState(false);
  const [setup, setSetup] = useState(false);
  const pendingSend = useRef<{scope: string; acknowledge?: (accepted: boolean) => void} | null>(null);
  const [error, setError] = useState<string | null>(null);
  useErrorToast(error);
  const [busy, setBusy] = useState(false);
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState<ChatProvider>("openai");
  const [model, setModel] = useState("");
  const history = usePonderSession(connection, hosted ? null : local?.session?.id ?? null);
  const taskInbox = useTaskInbox(connection, hosted ? null : local?.session?.id ?? null, history.events);
  useErrorToast(history.error);
  useErrorToast(taskInbox.error);
  const running = taskInbox.snapshot ? Boolean(taskInbox.snapshot.activeTurnId && !taskInbox.snapshot.paused) : history.running;
  useEffect(() => {
    const receipt = taskInbox.acknowledgedInput;
    if (!receipt || receipt.sessionId !== local?.session?.id) return;
    const pending = pendingSend.current;
    if (pending && typeof pending === "object" && pending.scope !== operationScope) return;
    pending?.acknowledge?.(true);
    pendingSend.current = null;
    setBusy(false);
    setDraft(current => current.trim() === receipt.body.trim() ? "" : current);
    taskInbox.acknowledgeRetainedInput();
  }, [taskInbox.acknowledgedInput, local?.session?.id, operationScope]);
  useEffect(() => {
    setHosted(false); setError(null); setDraft(""); setBusy(false); pendingSend.current = null;
  }, [operationScope]);
  useEffect(() => {
    if (!local) return;
    setSetup(!local.session);
    if (local.coordinator.modelRef) { setProvider(local.coordinator.modelRef.providerId); setModel(local.coordinator.modelRef.modelId); }
  }, [local]);
  async function start(nextProvider = provider, nextModel = model) {
    setBusy(true);
    try {
      const value = await apiFetch<LocalPonderState>(connection, "/v1/ponder/local", {method: "POST", body: JSON.stringify({modelRef:{providerId:nextProvider, modelId:nextModel}})});
      if (activeScope.current !== operationScope) return;
      setLocal(value); setProvider(nextProvider); setModel(nextModel); setSetup(false); setError(null);
    } catch (cause) { if (activeScope.current === operationScope) setError(localPonderError(cause)); }
    finally { if (activeScope.current === operationScope) setBusy(false); }
  }
  async function send(attachments: ChatAttachment[], promptOverride?: string) {
    const session = local?.session, prompt = (promptOverride ?? draft).trim();
    if (!session || !prompt || busy || pendingSend.current) return false;
    const operation = {scope: operationScope, acknowledge: undefined as ((accepted: boolean) => void) | undefined};
    pendingSend.current = operation;
    const durableAcknowledgement = new Promise<boolean>(resolve => { operation.acknowledge = resolve; });
    setBusy(true);
    try {
      const input = {prompt, attachments, modelRef: local.coordinator.modelRef ?? undefined, approvalPolicy: "on-request" as const, sandbox: "workspace-write" as const, codexPermissionMode: "default" as const, codexReasoningEffort:composer.codexReasoningEffort};
      // A durable receipt acknowledges Send; model completion arrives on the stream.
      // Reuse the canonical queue's retry identity, including when the task is idle.
      if (!await Promise.race([taskInbox.queue(input), durableAcknowledgement])) return false;
      if (activeScope.current !== operationScope) return false;
      setSubmissionVersion(value => value + 1);
      setDraft(current => current === draft ? "" : current); setError(null); return true;
    } catch (cause) { if (activeScope.current === operationScope) setError(localPonderError(cause)); return false; }
    finally { if (pendingSend.current === operation) pendingSend.current = null; if (activeScope.current === operationScope) setBusy(false); }
  }
  const providers = Object.values(composer.providerSettings?.statuses ?? {}).filter(status =>
    status.available && status.enabled && local?.supportedModelRefs?.some(ref => ref.providerId === status.id)
  ).map(status => ({value: status.id, label: status.displayName}));
  const models = modelOptionsForProvider(provider, composer.providerSettings).filter(option =>
    local?.supportedModelRefs?.some(ref => ref.providerId === provider && ref.modelId === option.value));
  useEffect(() => {
    if (local?.session || !local?.supportedModelRefs.length) return;
    const refs = local.supportedModelRefs;
    const preferred = refs.find(ref => ref.providerId === "openai" && ref.modelId === "gpt-6.1-sol")
      ?? refs.find(ref => ref.providerId === "anthropic" && ref.modelId === composer.providerSettings?.statuses.anthropic?.defaultModel)
      ?? refs.find(ref => ref.providerId === composer.provider && ref.modelId === composer.model)
      ?? refs[0];
    setProvider(preferred.providerId); setModel(preferred.modelId);
  }, [local, composer.providerSettings, composer.provider, composer.model]);
  const latestUsage = latestContextUsageFromEvents(history.events);
  const contextStatus = contextWindowStatusFromUsage({provider:local?.session?.provider ?? provider,
    snapshot:latestUsage?.model === local?.coordinator.modelRef?.modelId ? latestUsage : null,
    preferences:props.contextCompaction});
  return <div className="ponder-workspace">
    <div className="ponder-main">
      {hosted ? <><div className="ponder-connection-bar"><button type="button" onClick={() => setHosted(false)}>Return to local Pal</button></div><PonderHostedPanel {...props}/></> : <ConversationSurface scroll={{navigationVersion:props.navigationVersion,browserConversationId:local?.session?.id ?? null,
          chatSubmissionVersion:submissionVersion,chatMessages:history.messages,chatHistoryHasMore:history.hasMore,
          chatHistoryLoading:history.loading,onLoadMoreChatHistory:history.loadOlder,pendingApproval:null,showChatThread:true,
          showThinkingIndicator:running,turnRunning:running,view:"chat"}}
          thread={{...props.messageContext,connection,label:"Pal conversation",loading:!local || history.loading,
            onOpenSession:id => props.onOpenAgents(id), beforeMessages:<>
          {!local && snapshotQuery.isError ? <button type="button" onClick={() => void snapshotQuery.refetch()}>Retry opening Pal</button> : null}
          {local && !local.session ? <div className="ponder-empty"><h2>Meet Pal</h2><p>Delegate work and keep your agents coordinated in one conversation.</p><button type="button" onClick={() => setSetup(true)}>Set up local Pal</button></div> : null}
          {local?.session && !history.loading && history.messages.length === 0 ? <div className="ponder-empty"><h2>What would you like to work on?</h2><p>Tell Pal what you need. Delegated agents will appear on the right, and you can take control whenever you want.</p></div> : null}
          </>}} composer={<Composer {...composer} connection={connection} experience="chat" mode="dock" placeholder="Ask Pal to coordinate work…" showProjectFooter={false}
          provider={local?.session?.provider ?? provider} model={local?.coordinator.modelRef?.modelId ?? model}
          contextWindowStatus={contextStatus} allowedModelRefs={local?.supportedModelRefs ?? []} modelSelectionDisabled={running}
          onProviderChange={(nextProvider,nextModel) => { if (nextModel) void start(nextProvider,nextModel); }}
          onModelChange={nextModel => {void start(local?.session?.provider ?? provider,nextModel);}}
          executionControl={<PonderConnections state={local} connection={connection} accountScopeKey={props.accountScopeKey} onSetup={() => setSetup(true)}/>}
          goalSessionId={null} enableResourceContext={false}
          taskSessionId={local?.session?.id} taskEvents={history.events} prompt={draft} onPromptChange={setDraft}
          busy={busy || !local?.session} running={running} submissionScopeKey={`ponder-local:${local?.session?.id ?? "setup"}`}
          onSubmit={(attachments, _action, _command, options) => send(attachments ?? [], options?.promptOverride)}
          onStop={async () => { if (local?.session) { try { await sessionApi.interruptTurn(connection, local.session.id); } catch(cause) {setError(localPonderError(cause));} } }}/>}/>}
    </div>
    {setup && local ? <PonderSetupDialog onClose={() => setSetup(false)}>
      <header><h2 id="ponder-setup-title">Welcome to Pal</h2><button type="button" aria-label="Close setup" onClick={() => setSetup(false)}><X size={16}/></button></header>
      <p>Pal stands for Ponder Assisted Learning. It coordinates your agents. Start on this desktop and keep your conversation here.</p>
      <div className="ponder-setup-card"><h3>On this desktop</h3><p>Use your configured model. Your provider’s inference charges may apply.</p>
        <DropdownSelect label="Pal provider" value={provider} options={providers} onChange={value => {setProvider(value as ChatProvider); setModel(modelOptionsForProvider(value as ChatProvider, composer.providerSettings)[0]?.value ?? "");}}/>
        <DropdownSelect label="Pal model" value={model} options={models} onChange={setModel}/>
        {localQuery.isError ? <button type="button" className="git-dialog-secondary" onClick={()=>void localQuery.refetch()}>Retry loading models</button> : null}
        <button type="button" className="git-dialog-primary" disabled={busy || !model || !providers.some(option => option.value === provider)} onClick={() => void start(provider,model)}>{local.session ? "Save local model" : "Start locally"}</button>
        <button type="button" className="git-dialog-secondary" onClick={() => {setSetup(false);composer.onProviderSetupOpen?.();}}>Configure a provider</button>
      </div>
      <HostedSandboxesSetting connection={connection} accountScopeKey={props.accountScopeKey}/>
      {([['remoteAccess','Web and iOS access','Access local Pal without a subscription while your desktop stays online.'],['hostedCoordinator','Hosted Pal','Keep your coordinator available in the cloud. Activation uploads this Pal conversation.']] as const).map(([key,title,description]) => <div className="ponder-setup-card" key={key}><label><strong>{title}</strong><input type="checkbox" role="switch" checked={false} disabled aria-label={title}/></label><p>{description}</p><small>{local.capabilities[key].reason ?? "Setup is not available yet."}</small></div>)}
      <button type="button" className="git-dialog-secondary" onClick={() => {setHosted(true);setSetup(false);}}>Open existing hosted Pal</button>
    </PonderSetupDialog> : null}
  </div>;
}
