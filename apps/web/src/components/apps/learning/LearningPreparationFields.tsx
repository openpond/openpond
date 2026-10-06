import { reviewedTrainingPolicies } from "./draft";
import type { DraftFieldsProps } from "./LearningSourcesFields";

export function LearningPreparationFields({ draft, options, loading, onChange }: DraftFieldsProps) {
  const ids = options?.projects.find((item) => item.id === draft.projectId)?.configurationIds ?? [];
  const policies = reviewedTrainingPolicies(options, draft.configurationId);
  const grader = draft.graderSelection ?? { mode: "manual" as const };
  return (
    <>
      <label>
        Mode
        <select
          value={draft.mode}
          onChange={(event) =>
            onChange({ ...draft, mode: event.target.value as typeof draft.mode })
          }
        >
          <option value="evaluate">Evaluate only</option>
          <option value="train">Train automatically, approve candidate</option>
          <option value="activate">Train and activate automatically</option>
        </select>
      </label>
      <label>
        Model to train
        <select
          value={draft.configurationId}
          onChange={(event) => {
            const id = event.target.value,
              reviewed = reviewedTrainingPolicies(options, id);
            onChange({
              ...draft,
              configurationId: id,
              trainingPolicyId: reviewed.length === 1 ? reviewed[0]!.id : "",
              adapter: id
                ? { kind: "reference_text", inputPointer: "/prompt", match: "contained" }
                : { kind: "complete_text", qualitativeOnly: true },
            });
          }}
        >
          <option value="">{loading ? "Fetching configurations…" : "Select configuration"}</option>
          {options?.configurations
            .filter((item) => ids.includes(item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      {draft.mode !== "evaluate" ? (
        <label>
          Reviewed training setup
          <select
            value={draft.trainingPolicyId}
            onChange={(event) => onChange({ ...draft, trainingPolicyId: event.target.value })}
          >
            <option value="">Select reviewed setup</option>
            {policies.map((item) => (
              <option key={item.id} value={item.id}>
                Reviewed setup (version {item.revision})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.configurationId ? (
        <>
          <label>
            Task construction
            <select
              value={draft.adapter.kind}
              onChange={(event) =>
                onChange({
                  ...draft,
                  adapter:
                    event.target.value === "reference_text"
                      ? { kind: "reference_text", inputPointer: "/prompt", match: "contained" }
                      : { kind: "complete_text", qualitativeOnly: true },
                })
              }
            >
              <option value="reference_text">Match a published executable task</option>
              <option value="complete_text">Complete text context and calibrated judges</option>
            </select>
          </label>
          {draft.adapter.kind === "reference_text" ? (
            <div className="agent-learning-columns">
              <label>
                Public task input field
                <input
                  value={draft.adapter.inputPointer}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      adapter: {
                        kind: "reference_text",
                        inputPointer: event.target.value,
                        match:
                          draft.adapter.kind === "reference_text"
                            ? draft.adapter.match
                            : "contained",
                      },
                    })
                  }
                />
              </label>
              <label>
                Reference matching
                <select
                  value={draft.adapter.match}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      adapter: {
                        kind: "reference_text",
                        inputPointer:
                          draft.adapter.kind === "reference_text"
                            ? draft.adapter.inputPointer
                            : "/prompt",
                        match: event.target.value as "exact" | "contained",
                      },
                    })
                  }
                >
                  <option value="contained">Contained</option>
                  <option value="exact">Exact</option>
                </select>
              </label>
            </div>
          ) : null}
          <label>
            Grader selection
            <select
              value={grader.mode}
              onChange={(event) =>
                onChange({
                  ...draft,
                  graderSelection:
                    event.target.value === "auto"
                      ? {
                          mode: "auto",
                          modelId: "gpt-6-luna",
                          sampleSize: 8,
                          maximumOutputTokens: 2048,
                          maximumSpendUsd: 1,
                        }
                      : { mode: "manual" },
                })
              }
            >
              <option value="auto">Choose compatible rubrics automatically</option>
              <option value="manual">Use the pinned rubrics</option>
            </select>
          </label>
          {grader.mode === "auto" ? (
            <>
              <label>
                Selection model
                <select
                  value={grader.modelId}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      graderSelection: { ...grader, modelId: event.target.value },
                    })
                  }
                >
                  {!options?.generators.some((item) => item.id === grader.modelId) ? (
                    <option value={grader.modelId}>{grader.modelId}</option>
                  ) : null}
                  {options?.generators.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="agent-learning-columns">
                {(
                  [
                    ["sampleSize", "Sample examples", 1, 30],
                    ["maximumOutputTokens", "Output token limit", 256, 4096],
                    ["maximumSpendUsd", "Selection spending limit ($)", 0.01, 100000],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step={key === "maximumSpendUsd" ? 0.01 : 1}
                      value={grader[key]}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          graderSelection: { ...grader, [key]: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      <label>
        Answer improvement model
        <select
          value={draft.generator?.modelId ?? ""}
          onChange={(event) =>
            onChange({
              ...draft,
              generator: event.target.value
                ? {
                    modelId: event.target.value,
                    maximumOutputTokens: draft.generator?.maximumOutputTokens ?? 2048,
                    maximumSpendUsd: draft.generator?.maximumSpendUsd ?? 0.1,
                  }
                : null,
            })
          }
        >
          <option value="">Use recorded answers only</option>
          {options?.generators.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {draft.generator ? (
        <div className="agent-learning-columns">
          <label>
            Per improved answer limit ($)
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={draft.generator.maximumSpendUsd}
              onChange={(event) =>
                onChange({
                  ...draft,
                  generator: { ...draft.generator!, maximumSpendUsd: Number(event.target.value) },
                })
              }
            />
          </label>
          <label>
            Output token limit
            <input
              type="number"
              min={256}
              max={16384}
              value={draft.generator.maximumOutputTokens}
              onChange={(event) =>
                onChange({
                  ...draft,
                  generator: {
                    ...draft.generator!,
                    maximumOutputTokens: Number(event.target.value),
                  },
                })
              }
            />
          </label>
        </div>
      ) : null}
      {draft.mode === "activate" ? (
        <fieldset>
          <legend>Serving authorization</legend>
          <label>
            Serving target
            <select
              value={draft.serving?.targetId ?? ""}
              onChange={(event) =>
                onChange({
                  ...draft,
                  serving: {
                    targetId: event.target.value,
                    canarySeconds: draft.serving?.canarySeconds ?? 120,
                    rollbackOnRuntimeFailure: true,
                  },
                })
              }
            >
              <option value="">Ponder in this Project</option>
              {options?.servingTargets
                .filter((item) => item.projectId === draft.projectId && item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.hostedPonder ? "Hosted Ponder" : `${item.role} / ${item.roleTargetId}`}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Runtime canary (seconds)
            <input
              type="number"
              min={30}
              max={600}
              value={draft.serving?.canarySeconds ?? 120}
              onChange={(event) =>
                onChange({
                  ...draft,
                  serving: {
                    targetId: draft.serving?.targetId ?? "",
                    canarySeconds: Number(event.target.value),
                    rollbackOnRuntimeFailure: true,
                  },
                })
              }
            />
          </label>
          <p>
            Saving authorizes the selected target. Failed runtime checks restore its prior model.
            Training runs only within the saved policy's schedule and limits.
          </p>
        </fieldset>
      ) : null}
    </>
  );
}
