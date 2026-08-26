import { useMemo } from "react";
import type { RefinerHistoryPayload, RefinerRelease } from "@openpond/contracts";

import { Check, RotateCcw } from "../icons";

type Props = {
  busyReleaseHash: string | null;
  history: RefinerHistoryPayload;
  onRequestRelease: (release: RefinerRelease, operation: "activate" | "rollback") => void;
  onStartAuthoring?: (objective: string) => void;
};

const REFINER_AUTHORING_OBJECTIVE =
  "Update the Refiner Review Profile. Inspect the current profile first, ask what should change if it is not already clear, and show the exact release transition.";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "none";
}

export function RefinerProfileSettings({
  busyReleaseHash,
  history,
  onRequestRelease,
  onStartAuthoring,
}: Props) {
  const latestTransitionByRelease = useMemo(() => {
    const transitions = new Map<string, RefinerHistoryPayload["transitions"][number]>();
    for (const transition of history.transitions) {
      if (!transitions.has(transition.nextRelease.contentHash)) {
        transitions.set(transition.nextRelease.contentHash, transition);
      }
    }
    return transitions;
  }, [history.transitions]);

  return (
    <>
      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div>
            <h2>Review Profile</h2>
            <p>Separately versioned policy composed with the immutable Refiner Core.</p>
          </div>
          {onStartAuthoring ? (
            <button
              className="settings-primary compact"
              onClick={() => onStartAuthoring(REFINER_AUTHORING_OBJECTIVE)}
              type="button"
            >
              Edit with Work
            </button>
          ) : null}
        </div>
        <div className="harness-summary-grid">
          <article>
            <span>Active release</span>
            <strong>{shortHash(history.binding.release.contentHash)}</strong>
            <small>Binding revision {history.binding.revision}</small>
          </article>
          <article>
            <span>Profile</span>
            <strong>{history.currentRelease.profile.name}</strong>
            <small>{history.currentRelease.profile.id}@{history.currentRelease.profile.version}</small>
          </article>
          <article>
            <span>Core</span>
            <strong>{history.currentRelease.coreVersion}</strong>
            <small>{shortHash(history.currentRelease.coreHash)}</small>
          </article>
        </div>
        <p>{history.currentRelease.profile.objective}</p>
        {history.currentRelease.profile.instructions.length ? (
          <div className="harness-edit-list">
            {history.currentRelease.profile.instructions.map((instruction) => (
              <section className="harness-edit" key={instruction.id}>
                <div><strong>{instruction.id}</strong><span>{instruction.text}</span></div>
              </section>
            ))}
          </div>
        ) : (
          <div className="harness-empty compact">
            The default profile adds no instructions beyond the Refiner Core.
          </div>
        )}
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Profile releases</h2><p>Immutable definition history. Rollback changes future reviews only.</p></div>
          <span>{history.releases.length}</span>
        </div>
        <div className="harness-table-wrap">
          <table className="harness-table">
            <thead><tr><th>Profile</th><th>Release</th><th>Created</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {history.releases.map((release) => {
                const current = release.contentHash === history.binding.release.contentHash;
                const candidate = !current && latestTransitionByRelease.get(release.contentHash)?.bindingChanged === false;
                const operation = candidate ? "activate" : "rollback";
                return (
                  <tr key={release.contentHash}>
                    <td><strong>{release.profile.name}</strong><small>{release.profile.id}@{release.profile.version} · {release.profile.instructions.length} instructions</small></td>
                    <td><code>{shortHash(release.contentHash)}</code></td>
                    <td>{formatDate(release.createdAt)}</td>
                    <td><span className="harness-status">{current ? "active" : candidate ? "draft" : "immutable"}</span></td>
                    <td>{!current ? (
                      <button
                        aria-label={`${candidate ? "Activate" : "Roll back"} Refiner release`}
                        className="harness-table-icon-action"
                        disabled={busyReleaseHash !== null}
                        onClick={() => onRequestRelease(release, operation)}
                        title={`${candidate ? "Activate" : "Roll back"} Refiner release`}
                        type="button"
                      >
                        {candidate ? <Check size={14} /> : <RotateCcw size={14} />}
                      </button>
                    ) : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="harness-history-section">
        <div className="harness-section-heading">
          <div><h2>Definition changes</h2><p>Receipts record which release changed, why, and which authoring Skill produced it.</p></div>
          <span>{history.transitions.length}</span>
        </div>
        <div className="harness-table-wrap">
          <table className="harness-table">
            <thead><tr><th>Operation</th><th>Change</th><th>Release transition</th><th>Validation</th><th>Created</th></tr></thead>
            <tbody>{history.transitions.map((transition) => (
              <tr key={transition.contentHash}>
                <td><span className="harness-status">{transition.operation}{transition.bindingChanged ? " · active" : " · draft"}</span></td>
                <td><strong>{transition.reason}</strong><small>{transition.authoringSkillHash ? `Skill ${shortHash(transition.authoringSkillHash)}` : transition.actor}</small></td>
                <td><code>{shortHash(transition.previousRelease?.contentHash)} → {shortHash(transition.nextRelease.contentHash)}</code></td>
                <td>{transition.validation.valid ? "Passed" : transition.validation.messages.join("; ")}</td>
                <td>{formatDate(transition.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}
