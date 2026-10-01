import { createAcceptancePlan } from "openpond-sdk/learning";
import {
  postTrainingRecipe,
  PostTrainingAttachmentSchema,
  type PostTrainingAttachment,
  type HostedTrainingSetupCatalog,
} from "openpond-sdk/post-training";
export type HostedEvalChoices = {
  mode: "none" | "manual" | "automatic";
  budget: string;
  selected: string[];
  checks: Record<
    string,
    {
      role: "none" | "quality" | "retention" | "diagnostic";
      metric: string;
      threshold: string;
      regression: string;
      coverage: string;
      direction: "higher" | "lower";
    }
  >;
};
export const emptyHostedEvalChoices = (): HostedEvalChoices => ({
  mode: "none",
  budget: "1",
  selected: [],
  checks: {},
});
export function hostedSetupAttachment(
  value: HostedEvalChoices,
  catalog: HostedTrainingSetupCatalog,
  binding: PostTrainingAttachment["binding"],
) {
  if (value.mode === "none") return null;
  const experiments = value.selected.map((id) => {
    const found = catalog.experiments.find((e) => e.id === id);
    if (!found) throw new Error("A selected evaluation is no longer available.");
    return { id, configuration: found.configuration };
  });
  const checks = experiments.flatMap((item) => {
    const check = value.checks[item.id];
    if (!check || check.role === "none") return [];
    const retained = catalog.experiments.find((e) => e.id === item.id)!,
      grader = retained.graders.find((g) => g.feedbackKey === check.metric);
    if (!grader) throw new Error("Choose a retained scorer for every acceptance check.");
    return [
      {
        id: item.id,
        name: retained.name,
        role: check.role,
        required: check.role !== "diagnostic",
        unit: "fraction",
        ...postTrainingRecipe(item.configuration),
        evaluator: grader.ref,
        metric: check.metric,
        direction: check.direction,
        minimumCoverage: Number(check.coverage),
        threshold: Number(check.threshold),
        maximumRegression: Number(check.regression),
        maximumSpendUsd: item.configuration.maximumCostUsd * 2,
      },
    ];
  });
  const acceptancePlan = checks.length
    ? createAcceptancePlan({
        schemaVersion: "openpond.acceptancePlan.v1",
        id: `acceptance:${binding.id}`,
        revision: 1,
        checks,
        maximumSpendUsd: checks.reduce((sum, c) => sum + c.maximumSpendUsd, 0),
      })
    : null;
  return PostTrainingAttachmentSchema.parse({
    schemaVersion: "openpond.postTrainingAttachment.v1",
    binding,
    projectId: catalog.projectId,
    automatic: value.mode === "automatic",
    maximumSpendUsd: Number(value.budget),
    experiments,
    acceptancePlan,
  });
}
export function HostedTrainingEvaluationChoices({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: HostedTrainingSetupCatalog;
  value: HostedEvalChoices;
  onChange: (value: HostedEvalChoices) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>After training</legend>
      <label>
        Evaluations
        <select
          value={value.mode}
          onChange={(e) =>
            onChange({ ...value, mode: e.target.value as HostedEvalChoices["mode"] })
          }
        >
          <option value="none">No attached evaluations</option>
          <option value="manual">Attach evaluations / start manually</option>
          <option value="automatic">Run attached evaluations automatically</option>
        </select>
      </label>
      {value.mode !== "none" ? (
        <>
          <label>
            Separate evaluation spend limit ($)
            <input
              type="number"
              min="0.000001"
              max="10000"
              step="any"
              value={value.budget}
              onChange={(e) => onChange({ ...value, budget: e.target.value })}
            />
          </label>
          <p>
            Frozen holdouts stay separate from training data. Required checks compare the same
            baseline and candidate on the same cases and released scorer; their ceiling covers both
            executions.
          </p>
          {catalog.experiments.map((item) => {
            const selected = value.selected.includes(item.id),
              check = value.checks[item.id];
            return (
              <section key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => {
                      const checks = { ...value.checks };
                      checks[item.id] ??= {
                        role: "none",
                        metric: item.graders[0]?.feedbackKey ?? "",
                        threshold: "0.8",
                        regression: "0",
                        coverage: "1",
                        direction: "higher",
                      };
                      onChange({
                        ...value,
                        selected: e.target.checked
                          ? [...value.selected, item.id]
                          : value.selected.filter((id) => id !== item.id),
                        checks,
                      });
                    }}
                  />
                  {item.name} / dataset v{item.configuration.request.taskset.revision} /{" "}
                  {item.configuration.request.population.length} cases / $
                  {item.configuration.maximumCostUsd}
                </label>
                {selected && check ? (
                  <div>
                    <label>
                      Acceptance role
                      <select
                        value={check.role}
                        onChange={(e) =>
                          onChange({
                            ...value,
                            checks: {
                              ...value.checks,
                              [item.id]: { ...check, role: e.target.value as typeof check.role },
                            },
                          })
                        }
                      >
                        <option value="none">Optional evaluation</option>
                        <option value="quality">Required quality</option>
                        <option value="retention">Required retention</option>
                        <option value="diagnostic">Diagnostic in paired group</option>
                      </select>
                    </label>
                    {check.role !== "none" ? (
                      <>
                        <label>
                          Scorer
                          <select
                            value={check.metric}
                            onChange={(e) =>
                              onChange({
                                ...value,
                                checks: {
                                  ...value.checks,
                                  [item.id]: { ...check, metric: e.target.value },
                                },
                              })
                            }
                          >
                            {item.graders.map((g) => (
                              <option key={g.feedbackKey} value={g.feedbackKey}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Direction
                          <select
                            value={check.direction}
                            onChange={(e) =>
                              onChange({
                                ...value,
                                checks: {
                                  ...value.checks,
                                  [item.id]: {
                                    ...check,
                                    direction: e.target.value as typeof check.direction,
                                  },
                                },
                              })
                            }
                          >
                            <option value="higher">Higher is better</option>
                            <option value="lower">Lower is better</option>
                          </select>
                        </label>
                        {(["threshold", "regression", "coverage"] as const).map((key) => (
                          <label key={key}>
                            {key === "threshold"
                              ? "Required threshold"
                              : key === "regression"
                                ? "Maximum regression"
                                : "Minimum coverage"}{" "}
                            (fraction)
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="any"
                              value={check[key]}
                              onChange={(e) =>
                                onChange({
                                  ...value,
                                  checks: {
                                    ...value.checks,
                                    [item.id]: { ...check, [key]: e.target.value },
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
          {!catalog.experiments.length ? (
            <p>No frozen evaluation configurations are available in this Project.</p>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
