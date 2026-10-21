import { useContext, useState } from "react";
import {
  RunEvidencePanel,
  RunInspectionContext,
  type RunEvidenceInspection,
} from "./RunEvidencePanel";
import { useRunEvidenceTooltip } from "./useRunEvidenceTooltip";
import type { RunStageEvidence } from "@openpond/contracts";

/** Planned attempts and scored rewards use the same lane presentation as the console graph. */
export function TrainingRolloutGroups({ evidence }: { evidence: RunStageEvidence }) {
  const inspect = useContext(RunInspectionContext);
  const [inspection, setInspection] = useState<RunEvidenceInspection | null>(null);
  const select = inspect ?? setInspection;
  const rewards = evidence.groups.flatMap((group) =>
    group.attempts.flatMap((attempt) => (attempt.reward === null ? [] : [attempt.reward])),
  );
  const low = Math.min(...rewards),
    high = Math.max(...rewards);
  return (
    <div className="training-rollout-groups" aria-label="Attempts by rollout group">
      <header>
        <span>Attempts by rollout group</span>
        <div className="training-rollout-legend">
          {(
            [
              ["scored", "Scored"],
              ["active", "Running"],
              ["failed", "Failed"],
              ["", "Planned"],
            ] as const
          ).map(([state, label]) => (
            <span key={label}>
              <i className={`training-rollout-cell ${state}`} aria-hidden />
              {label}
            </span>
          ))}
        </div>
      </header>
      <ol>
        {evidence.groups.map((group) => {
          const inherited = group.inherited;
          const occupied = new Set(group.attempts.map((item) => item.slot));
          const pending = Array.from(
            { length: Math.min(1000, group.plannedSlots) },
            (_, slot) => slot,
          ).filter((slot) => !occupied.has(slot));
          return (
            <li key={group.index}>
              <GroupLink
                group={group}
                onSelect={() =>
                  select({
                    title: "Rollouts",
                    groupIndex: group.index,
                    status: group.state,
                    facts: group.diagnostics,
                  })
                }
              />
              <div>
                {group.replay ? <span className="training-muted">{group.state === "consumed" ? "Replayed" : "Replay pending"} · prior output not restored</span> : null}
                {inherited ? <span className="training-muted">Inherited · {inherited.optimizerDisposition === "applied" ? "Update applied" : "Skipped · no signal"}</span> : group.optimizerDisposition ? <span className="training-muted">{group.optimizerDisposition === "applied" ? "Update applied" : "Skipped · no signal"}</span> : null}
                {group.attempts.map((attempt) => {
                  const failed =
                    attempt.state.endsWith("failed") ||
                    ["cancelled", "expired", "timed_out"].includes(attempt.state);
                  const active =
                    evidence.live && ["running", "leased", "scoring"].includes(attempt.state);
                  const label = `Group ${group.index + 1}, slot ${attempt.slot + 1}, attempt ${attempt.attempt}: ${attempt.state}${attempt.reward === null ? "" : `, reward ${attempt.reward.toFixed(3)}`}`;
                  return (
                    <AttemptCell
                      key={attempt.id}
                      label={label}
                      attempt={attempt}
                      failed={failed}
                      active={active}
                      opacity={
                        attempt.reward === null
                          ? undefined
                          : high > low
                            ? 0.35 + (0.65 * (attempt.reward - low)) / (high - low)
                            : 0.8
                      }
                      onSelect={() =>
                        select({
                          title: "Rollouts",
                          groupIndex: group.index,
                          status: label,
                          facts: attempt.diagnostics,
                          feedback: attempt.feedback,
                        })
                      }
                    />
                  );
                })}

                {pending.map((slot) => (
                  <span
                    role="img"
                    key={`pending-${slot}`}
                    aria-label={`Group ${group.index + 1}, slot ${slot + 1}: planned`}
                    className="training-rollout-cell"
                  />
                ))}
              </div>
              <span>
                {inherited
                  ? inherited.outputPolicyVersion !== undefined ? `v${inherited.inputPolicyVersion} → v${inherited.outputPolicyVersion}` : `v${inherited.inputPolicyVersion} unchanged`
                  : group.meanReward === null
                    ? group.state
                    : `avg ${group.meanReward.toFixed(3)}`}
              </span>
            </li>
          );
        })}
      </ol>
      {inspection && !inspect ? <RunEvidencePanel {...inspection} /> : null}
      {evidence.groupCount > evidence.groups.length ? (
        <p>
          Showing {evidence.groups.length} of {evidence.groupCount} rollout groups.
        </p>
      ) : null}
    </div>
  );
}

function GroupLink({
  group,
  onSelect,
}: {
  group: RunStageEvidence["groups"][number];
  onSelect: () => void;
}) {
  const { triggerProps, tooltip, hideTooltip } = useRunEvidenceTooltip(
    <>
      <strong>Group {group.index + 1}</strong>
      <span>
        {group.inherited ? `Inherited source group · ${group.inherited.optimizerDisposition === "applied" ? "Update applied" : "Skipped · no signal"}. No attempts were rerun here.` : `${group.state} · ${group.attempts.length} retained attempts · reward ${group.meanReward ?? "not scored"}`}
      </span>
      <small>Select this group context.</small>
    </>,
  );
  return (
    <>
      <button
        {...triggerProps}
        className="training-rollout-group-link"
        type="button"
        onClick={() => {
          hideTooltip();
          onSelect();
        }}
      >
        Group {group.index + 1}
      </button>
      {tooltip}
    </>
  );
}
function AttemptCell({
  label,
  attempt,
  failed,
  active,
  opacity,
  onSelect,
}: {
  label: string;
  attempt: RunStageEvidence["groups"][number]["attempts"][number];
  failed: boolean;
  active: boolean;
  opacity?: number;
  onSelect: () => void;
}) {
  const finding = attempt.diagnostics?.find((item) => item.severity !== "info");
  const { triggerProps, tooltip, hideTooltip } = useRunEvidenceTooltip(
    <>
      <strong>{label}</strong>
      {finding ? (
        <span>
          {finding.label}: {finding.value.slice(0, 220)}
        </span>
      ) : null}
      <small>Select to inspect retained attempt evidence.</small>
    </>,
  );
  return (
    <>
      <button
        {...triggerProps}
        type="button"
        onClick={() => {
          hideTooltip();
          onSelect();
        }}
        aria-label={label}
        className={`training-rollout-cell ${failed ? "failed" : active ? "active" : attempt.reward !== null ? "scored" : ""}`}
        style={{ opacity }}
      />
      {tooltip}
    </>
  );
}
