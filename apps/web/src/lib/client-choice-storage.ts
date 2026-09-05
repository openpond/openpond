import { useEffect, useRef } from "react";
import { ClientChoicesSchema, CLIENT_CHOICE_KEYS, type ClientChoices } from "@openpond/persistence/schemas/client-state";
import { apiFetch, type ClientConnection } from "../api/api-client";

type State = { owner: string; value: ClientChoices; revision: number | null };
const listeners = new Set<() => void>();
let connection: ClientConnection | null = null, state: State | null = null;
let pending: ClientChoices = {}, inFlight: ClientChoices = {}, sending = false, generation = 0;
let failure: string | null = null;
let connectionRequest = 0;
export const CLIENT_CHOICES_CHANGED = "openpond-client-choices-changed";
function publish() {
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLIENT_CHOICES_CHANGED));
}
export function clientChoiceSaveIssue(): string | null { return failure; }
export function subscribeClientChoices(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useHydratedClientChoice(refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => subscribeClientChoices(() => latest.current()), []);
}
export async function connectClientChoices(next: ClientConnection): Promise<void> {
  const requestId = ++connectionRequest;
  const result = await apiFetch<{ clientState: State | null }>(next, "/v1/configuration");
  if (result.clientState?.revision === null) {
    const legacy = legacyViewChoices();
    if (Object.keys(legacy.patch).length) {
      result.clientState = await apiFetch<State>(next, "/v1/configuration", { method: "POST", body: JSON.stringify({ action: "client-state", owner: result.clientState.owner, patch: legacy.patch, importOnly: true }) });
      for (const key of legacy.keys) try { window.localStorage.removeItem(key); } catch { /* Acknowledged server state remains authoritative. */ }
    }
  }
  if (requestId !== connectionRequest) return;
  const ownerChanged = connection?.serverUrl !== next.serverUrl || connection?.token !== next.token || state?.owner !== result.clientState?.owner;
  if (ownerChanged) { generation++; pending = {}; inFlight = {}; failure = null; }
  connection = next;
  if (ownerChanged || (result.clientState?.revision ?? 0) >= (state?.revision ?? 0)) state = result.clientState;
  publish();
}
async function flush(): Promise<void> {
  if (sending || !connection || !state || !Object.keys(pending).length) return;
  sending = true;
  const batch = pending, currentConnection = connection, owner = state.owner, requestGeneration = generation;
  pending = {}; inFlight = batch;
  try {
    const accepted = await apiFetch<State>(currentConnection, "/v1/configuration", { method: "POST", body: JSON.stringify({ action: "client-state", owner, patch: batch }) });
    if (requestGeneration === generation) { state = accepted; failure = null; }
  } catch (error) {
    if (requestGeneration === generation) { pending = { ...batch, ...pending }; failure = `Preference changes have not been saved. ${error instanceof Error ? error.message : String(error)}`; }
  } finally {
    inFlight = {}; sending = false; publish();
    if (!failure && Object.keys(pending).length) void flush();
  }
}
export function retryClientChoiceSave(): void { failure = null; void flush(); }
export const clientChoiceStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem(key) {
    const field = CLIENT_CHOICE_KEYS[key as keyof typeof CLIENT_CHOICE_KEYS];
    if (!field) return null;
    const value = { ...state?.value, ...inFlight, ...pending }[field];
    return value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
  },
  setItem(key, serialized) {
    // Pre-bootstrap UI defaults never become writes, and old browser storage is never replayed.
    if (!state) return;
    const field = CLIENT_CHOICE_KEYS[key as keyof typeof CLIENT_CHOICE_KEYS];
    if (!field) throw new Error("Unregistered client preference.");
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { value = serialized; }
    const patch = ClientChoicesSchema.parse({ [field]: value });
    if (JSON.stringify({ ...state.value, ...inFlight, ...pending }[field]) === JSON.stringify(patch[field])) return;
    pending = { ...pending, ...patch };
    publish(); void flush();
  },
};

/** One-time import of non-authority view choices; permission/reasoning keys are excluded. */
function legacyViewChoices(): { patch: ClientChoices; keys: string[] } {
  const patch: ClientChoices = {}, keys: string[] = [];
  if (typeof window === "undefined") return { patch, keys };
  for (const [key, field] of Object.entries(CLIENT_CHOICE_KEYS)) {
    try {
      const text = window.localStorage.getItem(key);
      if (text === null) continue;
      let value: unknown;
      try { value = JSON.parse(text); } catch { value = text; }
      const parsed = ClientChoicesSchema.safeParse({ [field]: value });
      if (parsed.success) { Object.assign(patch, parsed.data); keys.push(key); }
    } catch { /* Unavailable browser storage is not an empty authoritative server record. */ }
  }
  return { patch, keys };
}
