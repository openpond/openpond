import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LocalTrainingModelBaseSchema, type LocalTrainingModelBase } from "@openpond/contracts/resource-setup";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useErrorToast } from "../../app/AppToastContext";
import { connectionQueryScope } from "../../lib/query-scope";
import { DropdownSelect } from "../DropdownSelect";

const route = "/v1/training/local-models";

export function ModelSetupLocalBase({ connection, selected, busy, onSelect, onBusy }: {
  connection: ClientConnection;
  selected?: LocalTrainingModelBase;
  busy: boolean;
  onSelect(base: LocalTrainingModelBase | undefined): void;
  onBusy(busy: boolean): void;
}) {
  const [directory, setDirectory] = useState("");
  const [pending, setPending] = useState<"import" | "verify" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const cache = useQueryClient();
  const queryKey = ["local-training-models", connectionQueryScope(connection)];
  const assets = useQuery({
    queryKey,
    queryFn: async ({ signal }) => LocalTrainingModelBaseSchema.array().parse(await apiFetch(connection, route, { signal })),
    retry: false,
  });
  useErrorToast(error ?? assets.error);
  const options = assets.data ?? [];
  const retained = selected && !options.some(asset => asset.preference.modelAssetId === selected.preference.modelAssetId) ? [selected, ...options] : options;
  const hasPicker = Boolean(window.openpond?.selectFolder);

  async function choose(id?: string) {
    if (busy || pending) return;
    setPending(id ? "verify" : "import");
    setError(null);
    onBusy(true);
    try {
      let asset: LocalTrainingModelBase;
      if (id) {
        asset = LocalTrainingModelBaseSchema.parse(await apiFetch(connection, `${route}/${id}`));
      } else {
        const folder = hasPicker ? await window.openpond!.selectFolder!() : { canceled: false, path: directory.trim() };
        if (folder.canceled || !folder.path) return;
        asset = LocalTrainingModelBaseSchema.parse(await apiFetch(connection, route, {
          method: "POST", body: JSON.stringify({ directory: folder.path }),
        }));
        void cache.invalidateQueries({ queryKey });
        setDirectory("");
      }
      onSelect(asset);
    } catch (cause) { setError(cause); }
    finally { setPending(null); onBusy(false); }
  }

  return <>
    <div className="resource-setup-input">
      <span>Local checkpoint</span>
      <DropdownSelect label="Local checkpoint" searchable disabled={busy || Boolean(pending)}
        value={selected?.preference.modelAssetId ?? ""}
        options={[
          { value: "", label: "Choose a saved checkpoint" },
          ...retained.map(base => ({
            value: base.preference.modelAssetId,
            label: base.label,
            description: `Revision ${base.preference.revision.slice(0, 12)}`,
          })),
        ]}
        onChange={id => { if (id) void choose(id); else onSelect(undefined); }} />
      {selected ? <small title={selected.preference.revision}>Saved revision {selected.preference.revision.slice(0, 12)}</small> : null}
    </div>
    {!hasPicker ? <label className="resource-setup-input">
      Checkpoint folder path
      <input value={directory} onChange={event => setDirectory(event.target.value)}
        disabled={busy || Boolean(pending)} />
    </label> : null}
    <button type="button" className="training-button secondary"
      disabled={busy || Boolean(pending) || (!hasPicker && !directory.trim())} onClick={() => void choose()}>
      {pending === "import" ? "Importing checkpoint" : "Import checkpoint folder"}
    </button>
  </>;
}
