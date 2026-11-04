import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalSha256, MODIFICATION_RECORDING_MAX_BYTES, ModificationRecordingDocumentSchema,
  verifyModificationRecordingRequest, type ModificationRecordingRequest } from "openpond-sdk/training";
import { AppDialog } from "../../dialogs/AppDialog";
import { ErrorToast } from "../../common/ErrorToast";
import { useDraftNavigation } from "../useDraftNavigation";
import { modificationRecordingApi } from "./modification-recording-api";
import type { WorkspaceApi } from "./workspace-api";

export function ModificationRecordingImport({ api, onOpen }: { api: WorkspaceApi; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [command, setCommand] = useState<ModificationRecordingRequest | null>(null);
  const file = useRef<HTMLInputElement>(null), queries = useQueryClient();
  const lifetime = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const guard = useDraftNavigation({ name: "Observation import", busy, dirty: Boolean(command) });
  function close() { void guard.requestLeave(() => { setOpen(false); setCommand(null); setError(null); }); }
  async function load(value: File) {
    setBusy(true); setError(null); setCommand(null);
    try {
      if (value.size > MODIFICATION_RECORDING_MAX_BYTES) throw new Error("Choose an observation JSON file of at most 8 MiB.");
      const document = ModificationRecordingDocumentSchema.parse(JSON.parse(await value.text()));
      const content = { schemaVersion: "openpond.modificationRecordingRequest.v1" as const, teamId: api.teamId,
        projectId: api.projectId, name: `${document.request.model.modelId.slice(0, 480)} observation`,
        method: document.request.variants.some(row => row.profile) ? "neuron_steering" as const : "inspect_activations" as const, ...document };
      // The same import retries the same immutable operation, including after a
      // lost reply or reopening the dialog. No paid execution is dispatched.
      const next = await verifyModificationRecordingRequest({ ...content, operationId: `import-${await canonicalSha256(content)}` });
      if (!lifetime.current.signal.aborted) setCommand(next);
    } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  async function retain() {
    if (!command) return;
    setBusy(true); setError(null);
    try {
      const result = await modificationRecordingApi(api, lifetime.current.signal).record(command);
      if (lifetime.current.signal.aborted) return;
      void queries.invalidateQueries({ queryKey: ["unified-experiments"] });
      guard.allowNextNavigation(); setOpen(false); setCommand(null); onOpen(result.id);
    } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  return <>
    <button className="training-button secondary" onClick={() => setOpen(true)}>Import observation</button>
    {open ? <AppDialog ariaLabel="Import activation observation" className="labs-rename-dialog" backdropClassName="labs-rename-backdrop"
      dismissDisabled={busy} onClose={close}>
      <h2>Import activation observation</h2><ErrorToast error={error} />
      <p>Import the request and result from your activation reference runtime. The observation stays on this device. Its measurements are externally supplied and ungraded.</p>
      <input ref={file} type="file" accept=".json,application/json" hidden disabled={busy} onChange={event => {
        const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void load(selected);
      }} />
      <button className="training-button secondary" disabled={busy} onClick={() => file.current?.click()}>Choose observation JSON</button>
      {command ? <dl className="evaluation-workspace-meta"><dt>Model</dt><dd>{command.request.model.modelId}</dd>
        <dt>Prompts</dt><dd>{command.request.prompts.length}</dd><dt>Variants</dt><dd>{command.request.variants.length}</dd>
        <dt>Captures</dt><dd>{command.result.captures.length}</dd></dl> : null}
      <div className="model-build-actions"><button className="training-button secondary" disabled={busy} onClick={close}>Close</button>
        <button className="training-button" disabled={busy || !command} onClick={() => void retain()}>{busy ? "Importing…" : "Import observation"}</button></div>
    </AppDialog> : null}{guard.dialog}
  </>;
}
