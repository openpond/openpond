import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ANTIGRAVITY_PROVIDER_ID,
  type AntigravitySetupState,
  type ProviderSettings,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { AppDialog } from "../dialogs/AppDialog";
import { ErrorToast } from "../common/ErrorToast";
import { DropdownSelect } from "../DropdownSelect";
import { Loader2, X } from "../icons";

type Props = {
  connection: ClientConnection | null;
  providers: ProviderSettings;
  onChanged(settings: ProviderSettings): void;
};
const pendingLogin = (state: AntigravitySetupState | null) =>
  Boolean(
    state?.login && ["starting", "waiting_for_code", "verifying"].includes(state.login.phase),
  );
const installing = (state: AntigravitySetupState | null) =>
  Boolean(state && ["checking", "downloading", "installing"].includes(state.runtime.phase));

export function AntigravityProviderCard({ connection, providers, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AntigravitySetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const flowId = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onChanged });
  callbacks.current = { onChanged };
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const mutationRevision = useRef(0);
  const storageKey = `openpond.antigravity.login:${connection?.serverUrl ?? ""}`;

  const request = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      if (!connection) throw new Error("Connect to OpenPond before configuring Antigravity.");
      const current = generation.current;
      const revision = action === "status" ? mutationRevision.current : ++mutationRevision.current;
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const next = await apiFetch<AntigravitySetupState>(
          connection,
          "/v1/providers/antigravity",
          {
            method: "POST",
            body: JSON.stringify({
              action,
              ...(flowId.current ? { flowId: flowId.current } : {}),
              ...extra,
            }),
            signal: controller.signal,
          },
        );
        if (
          generation.current !== current ||
          controller.signal.aborted ||
          (action === "status" && revision !== mutationRevision.current)
        )
          return null;
        if (next.login?.id) {
          flowId.current = next.login.id;
          try {
            sessionStorage.setItem(storageKey, next.login.id);
          } catch {
            /* Session storage is optional. */
          }
        }
        setState(next);
        if (next.settings) callbacks.current.onChanged(next.settings);
        return next;
      } finally {
        requests.current.delete(controller);
      }
    },
    [connection?.serverUrl, connection?.token, storageKey],
  );

  const act = useCallback(
    async (action: string, extra?: Record<string, unknown>) => {
      const current = generation.current;
      setBusy(true);
      setError(null);
      try {
        const next = await request(action, extra);
        if (next && action === "install" && !installing(next)) await request("refresh");
        if (next?.error) setError(next.error);
        if (["respond", "login", "cancel", "sign-out"].includes(action)) setCode("");
      } catch (failure) {
        if (
          current === generation.current &&
          !(failure instanceof DOMException && failure.name === "AbortError")
        )
          setError(failure instanceof Error ? failure.message : "Could not configure Antigravity.");
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [request],
  );

  useEffect(() => {
    generation.current++;
    setState(null);
    setCode("");
    setError(null);
    setBusy(false);
    try {
      flowId.current = sessionStorage.getItem(storageKey) ?? undefined;
    } catch {
      flowId.current = undefined;
    }
    if (connection)
      void request("status").catch((failure) => {
        if (failure.name !== "AbortError") setError(failure.message);
      });
    return () => {
      generation.current++;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, [request]);

  const working = installing(state);
  const signingIn = pendingLogin(state);
  useEffect(() => {
    if (busy || (!working && !signingIn)) return;
    let active = true;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void request("status")
        .then(async (next) => {
          if (!next) return;
          if ((working && !installing(next)) || (signingIn && next.login?.phase === "complete"))
            await act("refresh");
        })
        .catch((failure) => {
          if (active && failure.name !== "AbortError") setError(failure.message);
        })
        .finally(() => {
          polling = false;
        });
    }, 1_500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [working, signingIn, busy, request, act]);

  const status = providers.statuses[ANTIGRAVITY_PROVIDER_ID];
  const config = providers.providers[ANTIGRAVITY_PROVIDER_ID];
  const registered = Boolean(config?.acp);
  const enabled = config?.enabled ?? state?.enabled ?? false;
  const ready = status?.credential.connected || state?.status === "ready";
  const label = working
    ? "Installing Antigravity…"
    : signingIn
      ? "Google sign-in in progress"
      : ready
        ? enabled
          ? "Connected"
          : "Connected, disabled for chat"
        : !registered
          ? state?.runtime.version
            ? "Set up Antigravity"
            : "Not installed"
          : state?.status === "unavailable"
            ? "Connection needs attention"
            : "Sign in with Google";
  const modelCache = providers.modelCaches[ANTIGRAVITY_PROVIDER_ID]?.models ?? [];
  const blocked = busy || working || signingIn || !connection;
  const updateAvailable =
    state?.runtime.latestVersion && state.runtime.latestVersion !== state.runtime.version;
  const message =
    error ??
    state?.runtime.error ??
    state?.login?.error ??
    (state?.status === "unavailable" ? state.error : null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (code.trim()) await act("respond", { response: code });
  }

  async function saveModel(value: string) {
    if (!connection) return;
    const current = generation.current;
    const controller = new AbortController();
    requests.current.add(controller);
    mutationRevision.current++;
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<ProviderSettings>(connection, "/v1/providers", {
        method: "PATCH",
        body: JSON.stringify({ providers: { [ANTIGRAVITY_PROVIDER_ID]: { defaultModel: value } } }),
        signal: controller.signal,
      });
      if (current === generation.current && !controller.signal.aborted)
        callbacks.current.onChanged(next);
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : "Could not save the Antigravity model.",
        );
    } finally {
      requests.current.delete(controller);
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <>
      <div className="provider-connection-card" role="listitem">
        <div className="provider-connection-identity">
          <strong>Google Antigravity</strong>
          <label className="provider-toggle" aria-label="Enable Google Antigravity">
            <input
              type="checkbox"
              checked={enabled}
              disabled={blocked || !registered || !state?.runtime.version}
              onChange={(event) => void act(event.target.checked ? "enable" : "disable")}
            />
            <span />
          </label>
        </div>
        <div className={`provider-connection-status ${ready ? "ready" : "muted"}`}>
          <span>{label}</span>
        </div>
        <button
          type="button"
          className="settings-secondary"
          disabled={!connection}
          onClick={() => {
            setOpen(true);
            void act("refresh");
          }}
        >
          Manage
        </button>
      </div>
      {message ? <ErrorToast error={message} /> : null}
      {open ? (
        <AppDialog
          ariaLabel="Google Antigravity"
          backdropClassName="git-dialog-backdrop provider-dialog-backdrop"
          className="git-dialog provider-details-dialog"
          onClose={() => setOpen(false)}
        >
          <button
            type="button"
            className="git-dialog-close"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            <X size={18} />
          </button>
          <div className="provider-dialog-header">
            <div>
              <h2>Google Antigravity</h2>
              <span>Use your Google AI subscription in OpenPond.</span>
            </div>
          </div>
          <div className="provider-dialog-body native-agent-setup">
            <p>
              Sign in with your Google account to use the models included in your plan. Gemini 4
              Neon requires an eligible paid Google AI Pro or Ultra plan.
            </p>
            <div className="native-connection-status">
              <div role="status" aria-live="polite">
                {busy || working || signingIn ? (
                  <Loader2 size={16} className="settings-spin" />
                ) : null}
                <span>{label}</span>
              </div>
              <button
                type="button"
                className="settings-secondary"
                disabled={blocked}
                onClick={() => void act("refresh")}
              >
                Refresh
              </button>
            </div>
            {working ? (
              <div role="status">
                <p>
                  {state?.runtime.phase === "downloading"
                    ? `Downloading Antigravity${state.runtime.totalBytes ? ` · ${Math.floor((state.runtime.downloadedBytes / state.runtime.totalBytes) * 100)}%` : "…"}`
                    : state?.runtime.phase === "checking"
                      ? "Checking Google's current release…"
                      : "Verifying and installing Antigravity…"}
                </p>
              </div>
            ) : null}
            {state?.runtime.version ? (
              <small>
                Antigravity {state.runtime.version}
                {state.runtime.latestVersion === state.runtime.version ? " · Up to date" : ""}
              </small>
            ) : null}
            {!state?.runtime.version || !registered || updateAvailable ? (
              <button
                type="button"
                className="settings-secondary"
                disabled={blocked}
                onClick={() => void act("install")}
              >
                {!registered && state?.runtime.version
                  ? "Set up Antigravity"
                  : state?.runtime.version
                    ? `Update Antigravity${state.runtime.latestVersion ? ` to ${state.runtime.latestVersion}` : ""}`
                    : "Install Antigravity"}
              </button>
            ) : null}
            {state?.runtime.version && !updateAvailable ? (
              <button
                type="button"
                className="settings-secondary"
                disabled={blocked}
                onClick={() => void act("check-update")}
              >
                Check for updates
              </button>
            ) : null}
            {registered && state?.runtime.version && !signingIn && !ready ? (
              <button
                type="button"
                className="settings-primary"
                disabled={blocked}
                onClick={() => void act("login")}
              >
                Sign in with Google
              </button>
            ) : null}
            {state?.login?.phase === "starting" ? (
              <p role="status">Preparing your Google sign-in link…</p>
            ) : null}
            {state?.login?.phase === "waiting_for_code" && state.login.authorizationUrl ? (
              <form className="provider-card-form" onSubmit={(event) => void submit(event)}>
                <a
                  className="settings-secondary"
                  href={state.login.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google sign-in
                </a>
                <label className="settings-select-field">
                  <span>Google sign-in code</span>
                  <input
                    value={code}
                    autoComplete="off"
                    spellCheck={false}
                    type="password"
                    disabled={busy}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Paste the code or final page address"
                  />
                </label>
                <small>
                  Finish signing in on Google's page, then paste the code here. This also works when
                  OpenPond runs on another computer.
                </small>
                <button className="settings-primary" disabled={busy || !code.trim()}>
                  Continue
                </button>
              </form>
            ) : null}
            {state?.login?.phase === "verifying" ? (
              <p role="status">Verifying your Google account and loading available models…</p>
            ) : null}
            {signingIn ? (
              <button
                type="button"
                className="settings-secondary"
                disabled={busy}
                onClick={() => void act("cancel")}
              >
                Cancel sign-in
              </button>
            ) : null}
            {modelCache.length ? (
              <label className="settings-select-field">
                <span>Default model</span>
                <DropdownSelect
                  label="Antigravity default model"
                  value={config?.defaultModel ?? modelCache[0]!.id}
                  options={modelCache.map((model) => ({
                    value: model.id,
                    label: model.displayName,
                  }))}
                  searchable
                  disabled={blocked}
                  onChange={(value) => void saveModel(value)}
                />
              </label>
            ) : null}
            {registered && state?.runtime.version ? (
              <button
                type="button"
                className="settings-secondary"
                disabled={blocked}
                onClick={() => void act("sign-out")}
              >
                Sign out of Google
              </button>
            ) : null}
          </div>
        </AppDialog>
      ) : null}
    </>
  );
}
