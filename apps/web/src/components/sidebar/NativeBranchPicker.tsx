import type { NativeBranchChoice, NativeBranchInspection } from "@openpond/evals/native-conversations";

export function NativeBranchPicker({ title, inspection, busy, onSelect, onRefresh, onClose }: {
  title: string;
  inspection: NativeBranchInspection;
  busy: boolean;
  onSelect(branch: NativeBranchChoice): void;
  onRefresh(): void;
  onClose(): void;
}) {
  return <section className="native-branch-picker" aria-label="Choose Claude conversation branch">
    <strong>{title || "Claude conversation"}</strong>
    <p>This conversation has multiple branches. Choose the history to view. Each branch opens as a read-only snapshot.</p>
    {inspection.branches.map(branch => <button type="button" key={branch.leafId} disabled={busy} onClick={() => onSelect({ leafId: branch.leafId, revision: inspection.revision })}>
      <span>{branch.title || "Branch without a text message"}</span>
      <small>{branch.messages} messages · {branch.updatedAt ? new Date(branch.updatedAt).toLocaleString() : "Date unavailable"}</small>
      <code>{branch.leafId}</code>
    </button>)}
    <div><button type="button" disabled={busy} onClick={onRefresh}>Refresh branches</button><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
  </section>;
}
