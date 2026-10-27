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
import { createComposerDraftStore } from "../lib/composer-draft-store";
import { contextWindowStatusFromUsage } from "../lib/context-window";
import { useToastPresentation } from "../hooks/useToastPresentation";
import "../styles/theme.css";
import "../styles.css";

// Development-only boundary proof. Audio and API receipts are synthetic: no
// microphone permission, server request, provider turn, or account write occurs.
const connection = { serverUrl: "http://proof.invalid", token: "synthetic", platform: "web" };
const localQueue = new URLSearchParams(window.location.search).has("local");
const steerMode = new URLSearchParams(window.location.search).has("steer");
const initialDraft = {
  id: "local-draft",
  prompt: "Edit this queued instruction",
  createdAt: "2026-10-21T12:00:00Z",
  updatedAt: "2026-10-21T12:00:00Z",
};
const inputs = new Map<string, TaskInput>();
let finishTranscription: (() => void) | undefined;
let acceptQueue: (() => void) | undefined;
let holdInitialInbox = !steerMode;
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
    activeTurnId: "running-turn",
    acceptingInput: true,
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
                  A synthetic agent turn is running. Queue a draft, then accept its receipt. Edit
                  must remove it from the queue.
                </div>
              </div>
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
                <DraftBoundComposer
                  draftStore={draftStore}
                  composerDraftStore={draftStore}
                  mode="dock"
                  busy
                  running
                  steerActiveResponses={steerMode}
                  attachmentRequest={attachmentRequest}
                  connection={localQueue ? null : connection}
                  provider="claude-code"
                  model="default"
                  taskSessionId={localQueue ? null : scope}
                  initialSteerDrafts={localQueue ? [initialDraft] : undefined}
                  submissionScopeKey={scope}
                  getCurrentSubmissionScopeKey={() => activeScope.current}
                  voiceInputChannelKey={`queue-proof:${scope}`}
                  enableResourceContext={false}
                  showProjectFooter={false}
                  contextWindowStatus={contextWindowStatusFromUsage({
                    provider: "claude-code",
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
                  onSubmit={async () => {
                    throw new Error("Queue incorrectly used ordinary Send.");
                  }}
                  onStop={() => {}}
                />
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
});
