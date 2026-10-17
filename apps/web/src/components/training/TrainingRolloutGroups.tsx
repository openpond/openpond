import type { RunStageEvidence } from "@openpond/contracts";
import { TrainingAttemptTable } from "./TrainingAttemptTable";

/** Planned attempts and scored rewards use the same lane presentation as the console graph. */
export function TrainingRolloutGroups({ evidence }: { evidence: RunStageEvidence }) {
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
          const reused = group.state === "reused";
          const occupied = new Set(group.attempts.map((item) => item.slot));
          const pending = Array.from(
            { length: Math.min(1000, group.plannedSlots) },
            (_, slot) => slot,
          ).filter((slot) => !occupied.has(slot));
          return (
            <li key={group.index}>
              <span>Group {group.index + 1}</span>
              <div>
                {reused ? <span role="img" className="training-rollout-cell reused"
                  title={`Reused from the source run · policy v${evidence.recovery?.policyVersion}`}
                  aria-label={`Group ${group.index + 1}: reused from the source run`}>✓</span> : null}
                {group.attempts.map((attempt) => {
                  const failed =
                    attempt.state.endsWith("failed") ||
                    ["cancelled", "expired", "timed_out"].includes(attempt.state);
                  const active =
                    evidence.live && ["running", "leased", "scoring"].includes(attempt.state);
                  const label = `Group ${group.index + 1}, slot ${attempt.slot + 1}, attempt ${attempt.attempt}: ${attempt.state}${attempt.reward === null ? "" : `, reward ${attempt.reward.toFixed(3)}`}`;
                  return (
                    <span
                      role="img"
                      title={label}
                      aria-label={label}
                      key={attempt.id}
                      className={`training-rollout-cell ${failed ? "failed" : active ? "active" : attempt.reward !== null ? "scored" : ""}`}
                      style={
                        attempt.reward !== null
                          ? {
                              opacity:
                                high > low
                                  ? 0.35 + (0.65 * (attempt.reward - low)) / (high - low)
                                  : 0.8,
                            }
                          : undefined
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
                {reused ? `Reused · v${evidence.recovery?.policyVersion}` : group.meanReward === null ? group.state : `avg ${group.meanReward.toFixed(3)}`}
              </span>
            </li>
          );
        })}
      </ol>
      <TrainingAttemptTable groups={evidence.groups} />
      {evidence.groupCount > evidence.groups.length ? (
        <p>
          Showing {evidence.groups.length} of {evidence.groupCount} rollout groups.
        </p>
      ) : null}
    </div>
  );
}
