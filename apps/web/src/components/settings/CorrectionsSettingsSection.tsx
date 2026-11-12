import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DesktopCorrectionsChoicesSchema, DesktopCorrectionsStateSchema } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useErrorToast } from "../../app/AppToastContext";
import { DropdownSelect } from "../DropdownSelect";
import { desktopCorrectionsRequest, useDesktopCorrections } from "../chat/DesktopCorrectionsContext";
import { modelsLocation, navigateDesktopRoute } from "../labs/lab-primary-tab-state";

export function CorrectionsSettingsSection({ connection }: { connection: ClientConnection | null }) {
  const corrections = useDesktopCorrections();
  const current = corrections?.data;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choices = useQuery({ queryKey: ["desktop-corrections-choices", connection?.serverUrl, current?.scopeKey], enabled: Boolean(connection && current),
    queryFn: async ({ signal }) => DesktopCorrectionsChoicesSchema.parse(await desktopCorrectionsRequest(connection!, current!.teamId, { actorId: current!.actorId, action: "choices" }, signal)),
  });
  useErrorToast(error ?? choices.error ?? corrections?.error ?? current?.destinationError);
  if (!corrections) return null;
  const options = choices.data?.datasets.map(({ id, name }) => ({ value: id, label: name })) ?? [];
  if (current?.dataset && !options.some(option => option.value === current.dataset!.id)) options.unshift({ value: current.dataset.id, label: current.dataset.name });
  async function select(datasetId: string) {
    if (!connection || !current || saving) return;
    setSaving(true); setError(null);
    try {
      DesktopCorrectionsStateSchema.parse(await desktopCorrectionsRequest(connection, current.teamId, {
        actorId: current.actorId, action: "select", datasetId, expectedSelectionRevision: current.selectionRevision,
      }));
      await corrections!.refresh();
    } catch (cause) { setError(cause); }
    finally { setSaving(false); }
  }
  return <section className="account-settings" aria-label="Issue logging settings">
    <h2>Issue logging</h2>
    <p>Log an issue in a conversation to ask the agent to save a task, then continue its work.</p>
    <div className="provider-settings-grid single"><label className="settings-select-field">
      <span>Default issue dataset</span>
      <DropdownSelect label="Default issue dataset" value={current?.dataset?.id ?? ""} options={options}
        disabled={!current || saving || choices.isPending} onChange={value => void select(value)} />
    </label></div>
    {current?.dataset ? <>
      <button type="button" className="settings-secondary" onClick={() => void navigateDesktopRoute({ kind: "models", route: modelsLocation("datasets", null, {
        area: "console", resourceId: current.dataset!.id, detailTab: "tasks", projectId: null, executionLocation: "hosted",
      }) })}>Open dataset</button>
      <p className="settings-footnote">Default rubric: Instruction following. Choose a judge and calibrate it when you are ready to grade. Logging does not start grading or training.</p>
    </> : null}
    {corrections.error || choices.error ? <button type="button" className="settings-secondary" onClick={() => { void corrections.refresh(); void choices.refetch(); }}>Retry</button> : null}
  </section>;
}
