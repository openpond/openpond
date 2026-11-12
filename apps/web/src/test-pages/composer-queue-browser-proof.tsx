import { useCallback, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChatAttachmentSchema, type TaskInput } from "@openpond/contracts";
import { api } from "../api";
import { sessionApi } from "../api/session-api";
import { AppToastProvider } from "../app/AppToastContext";
import { appReducer, initialAppState, type ShowAppToast } from "../app/app-state";
import { AppToast } from "../components/app-shell/AppToast";
import { DraftBoundComposer } from "../components/chat/DraftBoundComposer";
import { DesktopCorrectionsContext } from "../components/chat/DesktopCorrectionsContext";
import { CorrectionsSettingsSection } from "../components/settings/CorrectionsSettingsSection";
import { UserMessageContent } from "../components/chat/UserMessageContent";
import { createComposerDraftStore } from "../lib/composer-draft-store";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import { useToastPresentation } from "../hooks/useToastPresentation";
import "../styles/theme.css";
import "../styles.css";
import "../styles/settings/settings-layout.css";
import "../styles/settings/settings-forms.css";

// Development-only boundary proof. Audio and API receipts are synthetic: no
// microphone permission, server request, provider turn, or account write occurs.
const connection = { serverUrl: "http://proof.invalid", token: "synthetic", platform: "web" };
const localQueue = new URLSearchParams(window.location.search).has("local");
const params = new URLSearchParams(window.location.search);
const correctionsProof = params.has("corrections");
const idleProof = params.has("idle");
const newChatProof = params.has("new-chat");
const historyProof = params.has("history");
let correctionDataset = { id: "proof-corrections", name: "Corrections", revision: 1 };
let correctionSelectionRevision = 0;
const correctionState = () => ({ scopeKey: "a".repeat(64), teamId: "proof-workspace", actorId: "proof-owner", defaultDatasetId: "proof-corrections",
  dataset: correctionDataset, destinationError: null, selectionRevision: correctionSelectionRevision, graderDraftId: "proof-grader", graderState: "draft" as const });
const provider = params.get("provider") === "codex" ? "codex" : "claude-code";
const initialDraft = {
  id: "local-draft",
  prompt: "Edit this queued instruction",
  createdAt: "2026-10-21T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
};
const inputs = new Map<string, TaskInput>();
let finishTranscription: (() => void) | undefined;
let acceptQueue: (() => void) | undefined;
let holdInitialInbox = params.has("hold-inbox");
let changed = () => {};
let failed = false;
const originals = {
  taskInbox: sessionApi.taskInbox,
  queue: sessionApi.queueTaskInput,
  steer: sessionApi.steerTurn,
  mutate: sessionApi.updateTaskInput,
  status: api.voiceTranscriptionStatus,
  transcribe: api.transcribeVoice,
  microphone: navigator.mediaDevices.getUserMedia,
  fetch: globalThis.fetch,
};
if (params.has("correction-settings")) globalThis.fetch = async (resource, init) => {
  if (String(resource).startsWith(connection.serverUrl) && init?.body) {
    const request = JSON.parse(String(init.body));
    if (request.operation === "desktopCorrections") {
      if (request.value.action === "choices") return Response.json({ datasets: [
        { id: "proof-corrections", name: "Corrections", revision: 1 }, { id: "proof-other", name: "Reviewed issues", revision: 1 },
      ] });
      if (request.value.action === "select") {
        correctionDataset = { id: request.value.datasetId, name: request.value.datasetId === "proof-other" ? "Reviewed issues" : "Corrections", revision: 1 };
        correctionSelectionRevision++;
        changed(); return Response.json(correctionState());
      }
    }
  }
  return originals.fetch(resource, init);
};
const syntheticAudio = new AudioContext();
const destination = syntheticAudio.createMediaStreamDestination();
const oscillator = syntheticAudio.createOscillator();
oscillator.connect(destination);
oscillator.start();
navigator.mediaDevices.getUserMedia = async () => {
  await syntheticAudio.resume();
  return destination.stream.clone();
};
sessionApi.taskInbox = async (_connection, sessionId) => {
  if (holdInitialInbox) await new Promise<void>(() => {});
  return {
    sessionId,
    activeTurnId: idleProof ? null : "running-turn",
    acceptingInput: !idleProof,
    paused: false,
    inputs: [...inputs.values()].filter((input) => input.sessionId === sessionId),
    waits: [],
  };
};
sessionApi.queueTaskInput = async (_connection, sessionId, request, idempotencyKey) => {
  await new Promise<void>((resolve) => {
    acceptQueue = resolve;
    changed();
  });
  acceptQueue = undefined;
  holdInitialInbox = false;
  changed();
  if (failed) throw new Error("Synthetic queue rejection; draft retained.");
  const now = new Date().toISOString();
  const receipt: TaskInput = {
    id: idempotencyKey,
    idempotencyKey,
    sessionId,
    sequence: inputs.size + 1,
    senderSessionId: null,
    senderKind: "user",
    kind: "queued",
    body: request.prompt,
    payload: request,
    replyTo: null,
    expectedTurnId: null,
    turnId: null,
    requestIds: [],
    state: "pending",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    error: null,
  };
  inputs.set(receipt.id, receipt);
  return receipt;
};
sessionApi.steerTurn = async (currentConnection, sessionId, request) => {
  const queued = await sessionApi.queueTaskInput(
    currentConnection,
    sessionId,
    {
      prompt: request.prompt,
      attachments: request.attachments,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      codexPermissionMode: "default",
    },
    request.idempotencyKey,
  );
  const receipt = {
    ...queued,
    kind: "steer" as const,
    expectedTurnId: request.expectedTurnId,
    turnId: request.expectedTurnId,
    state: "resolved" as const,
  };
  inputs.set(receipt.id, receipt);
  changed();
  return receipt;
};
sessionApi.updateTaskInput = async (_connection, _sessionId, id) => {
  const input = inputs.get(id)!;
  const receipt = { ...input, state: "cancelled" as const, revision: input.revision + 1 };
  inputs.set(id, receipt);
  return receipt;
};
api.voiceTranscriptionStatus = async () => ({
  available: true,
  binaryPath: "synthetic",
  modelName: "synthetic",
  modelPath: "synthetic",
  modelReady: true,
  canDownloadModel: false,
  installHint: null,
});
api.transcribeVoice = async () => {
  await new Promise<void>((resolve) => {
    finishTranscription = resolve;
    changed();
  });
  finishTranscription = undefined;
  changed();
  return {
    text: "Dictated follow-up",
    binaryPath: "synthetic",
    modelName: "synthetic",
    modelPath: "synthetic",
    durationMs: 1000,
  };
};

function Proof() {
  const [, update] = useReducer((value) => value + 1, 0);
  changed = update;
  const [scope, setScope] = useState("origin");
  const [attachmentRequest, setAttachmentRequest] = useState<{ id: number; file: File } | null>(
    null,
  );
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [draftStore] = useState(() =>
    createComposerDraftStore({
      selectedSessionId: "origin",
      selectedAppId: null,
      selectedProjectId: null,
    }),
  );
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const counter = useRef(0);
  const showToast = useCallback<ShowAppToast>((message, tone = "info", options = {}) => {
    const id = ++counter.current;
    dispatch({
      type: "showToast",
      toast: { id, createdAt: Date.now(), message, tone, ...options },
    });
    return id;
  }, []);
  const dismiss = useCallback((toastId: number) => dispatch({ type: "clearToast", toastId }), []);
  const presentation = useToastPresentation(state.toasts, dismiss, scope);
  return (
    <AppToastProvider showToast={showToast}>
      <div className="app-shell sidebar-closed">
        <div className="content-shell">
          <div className="topbar" style={{ padding: "0 24px" }}>
            Queue and dictation · {scope}
          </div>
          <main className="main-pane" style={{ display: "block", padding: 32 }}>
            <div style={{ maxWidth: 800, margin: "0 auto" }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
                <button
                  onClick={() => {
                    const next = scope === "origin" ? "other" : "origin";
                    draftStore.applyAppAction({ type: "selectSession", sessionId: next });
                    setScope(next);
                  }}
                >
                  Switch chat
                </button>
                <button disabled={!finishTranscription} onClick={() => finishTranscription?.()}>
                  Finish transcription
                </button>
                <button disabled={!acceptQueue} onClick={() => acceptQueue?.()}>
                  Accept input
                </button>
                <button
                  onClick={() =>
                    setAttachmentRequest({
                      id: Date.now(),
                      file: new File(["Attached evidence for the running turn."], "evidence.txt", {
                        type: "text/plain",
                      }),
                    })
                  }
                >
                  Attach evidence
                </button>
                <button
                  onClick={async () =>
                    setAttachmentRequest({
                      id: Date.now(),
                      file: new File(
                        [await (await fetch("/favicon-32x32.png")).blob()],
                        "sample-image.png",
                        { type: "image/png" },
                      ),
                    })
                  }
                >
                  Attach preview image
                </button>
                <label>
                  <input
                    type="checkbox"
                    onChange={(event) => {
                      failed = event.target.checked;
                    }}
                  />
                  Reject queue
                </label>
              </div>
              <div className="message-row assistant">
                <div className="assistant-message">
                  A synthetic agent turn is running. Enter or Send steers immediately; Ctrl Enter queues.
                  Accept the receipt to finish submission.
                </div>
              </div>
              <output aria-label="Accepted input kinds">
                {[...inputs.values()].map(input => `${input.kind}: ${input.body}`).join("\n")}
              </output>
              <output aria-label="Accepted steering files">
                {[...inputs.values()]
                  .filter((input) => input.kind === "steer")
                  .map(
                    (input) =>
                      `Steered: ${input.body} · ${ChatAttachmentSchema.array()
                        .parse(input.payload.attachments ?? [])
                        .map((file) => `${file.name}: ${file.text ?? "attached"}`)
                        .join(", ")}`,
                  )
                  .join("\n")}
              </output>
              <div className="composer-stack dock" style={{ marginTop: 100 }}>
                <DesktopCorrectionsContext.Provider value={correctionsProof ? {
                  data: correctionState(),
                  loading: false, error: null, webBaseUrl: "https://app.example.test", refresh: async () => { changed(); },
                } : null}>
                {params.has("correction-settings") ? <CorrectionsSettingsSection connection={connection} /> : null}
                {correctionsProof ? <div aria-label="Issue message preview">
                  {[...inputs.values()].map(input => <UserMessageContent key={input.id} content={input.body} />)}
                </div> : null}
                <DraftBoundComposer
                  draftStore={draftStore}
                  composerDraftStore={draftStore}
                  mode={newChatProof ? "start" : "dock"}
                  busy={!idleProof && !historyProof}
                  running={!idleProof && !historyProof}
                  attachmentRequest={attachmentRequest}
                  connection={localQueue ? null : connection}
                  provider={provider}
                  model="default"
                  taskSessionId={localQueue || newChatProof || historyProof ? null : scope}
                  conversationId={newChatProof ? null : historyProof ? `codex-history:${scope}` : scope}
                  initialSteerDrafts={localQueue ? [initialDraft] : undefined}
                  submissionScopeKey={scope}
                  getCurrentSubmissionScopeKey={() => activeScope.current}
                  voiceInputChannelKey={`queue-proof:${scope}`}
                  enableResourceContext={false}
                  showProjectFooter={false}
                  contextWindowStatus={contextWindowStatusFromUsage({
                    provider,
                    snapshot: null,
                  })}
                  projectTarget={{
                    value: "",
                    label: "Local project",
                    detail: "",
                    options: [],
                    busy: false,
                  }}
                  workspaceTarget={{
                    value: "local",
                    label: "Local",
                    detail: "",
                    options: [],
                    busy: false,
                    action: { value: "local", label: "Local", detail: "", disabled: false },
                  }}
                  codexPermissionMode="full-access"
                  codexReasoningEffort="high"
                  openPondCommandAccessMode="full-access"
                  onProviderChange={() => {}}
                  onProjectTargetChange={() => {}}
                  onWorkspaceTargetChange={() => {}}
                  onModelChange={() => {}}
                  onCodexPermissionModeChange={() => {}}
                  onCodexReasoningEffortChange={() => {}}
                  onOpenPondCommandAccessModeChange={() => {}}
                  showToast={showToast}
                  onSubmit={async (_attachments, _action, _command, options) => {
                    if (correctionsProof && (idleProof || historyProof)) {
                      if (!options?.preservePrompt || !options.promptOverride) throw new Error("Issue logging consumed the draft.");
                      const timestamp = new Date().toISOString();
                      inputs.set("idle-issue", { id: "idle-issue", idempotencyKey: "idle-issue", sessionId: historyProof ? `codex-history:${scope}` : scope, sequence: inputs.size + 1,
                        senderSessionId: null, senderKind: "user", kind: "message", body: options.promptOverride, payload: {}, replyTo: null,
                        expectedTurnId: null, turnId: null, requestIds: [], state: "resolved", revision: 1, createdAt: timestamp, updatedAt: timestamp, error: null });
                      changed(); return true;
                    }
                    throw new Error("Queue incorrectly used ordinary Send.");
                  }}
                  onSaveTaskDraft={async () => {
                    throw new Error("Running shortcut incorrectly saved a task draft.");
                  }}
                  onStop={() => {}}
                />
                </DesktopCorrectionsContext.Provider>
              </div>
            </div>
          </main>
          <div className="app-toast-anchor">
            <AppToast {...presentation} />
          </div>
        </div>
      </div>
    </AppToastProvider>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Proof />
  </QueryClientProvider>,
);
import.meta.hot?.dispose(() => {
  root.unmount();
  void syntheticAudio.close();
  navigator.mediaDevices.getUserMedia = originals.microphone;
  sessionApi.taskInbox = originals.taskInbox;
  sessionApi.queueTaskInput = originals.queue;
  sessionApi.steerTurn = originals.steer;
  sessionApi.updateTaskInput = originals.mutate;
  api.voiceTranscriptionStatus = originals.status;
  api.transcribeVoice = originals.transcribe;
  globalThis.fetch = originals.fetch;
});
