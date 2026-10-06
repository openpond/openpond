import { AGENT_SOURCES } from "../agent-connections";
import { sourceKey, type LearningOptions } from "./contracts";
import type { LearningDraft } from "./draft";

export type DraftFieldsProps = {
  draft: LearningDraft;
  options?: LearningOptions;
  loading: boolean;
  onChange(value: LearningDraft): void;
};
export function LearningSourcesFields({ draft, options, loading, onChange }: DraftFieldsProps) {
  const sources = options?.sources.filter((item) => item.projectId === draft.projectId) ?? [];
  const eligible = sources.filter((item) => ["active", "paused"].includes(item.state));
  const all =
    eligible.length > 0 && eligible.every((item) => draft.sourceKeys.includes(sourceKey(item)));
  const setKeys = (sourceKeys: string[]) => onChange({ ...draft, sourceKeys });
  const graders = options?.graders.flatMap((item) => (item ? [item] : [])) ?? [];
  return (
    <>
      <fieldset>
        <legend>Source agents</legend>
        <label className="agent-learning-check">
          <input
            type="checkbox"
            checked={all}
            disabled={!eligible.length}
            ref={(element) => {
              if (element)
                element.indeterminate =
                  !all && eligible.some((item) => draft.sourceKeys.includes(sourceKey(item)));
            }}
            onChange={(event) =>
              setKeys(
                event.target.checked
                  ? [...new Set([...draft.sourceKeys, ...eligible.map(sourceKey)])]
                  : draft.sourceKeys.filter(
                      (key) => !eligible.some((item) => sourceKey(item) === key),
                    ),
              )
            }
          />
          Select all{" "}
          <small>
            ({sources.filter((item) => draft.sourceKeys.includes(sourceKey(item))).length} selected)
          </small>
        </label>
        <div className="agent-learning-options" aria-label="Source agents">
          {sources.map((source) => {
            const key = sourceKey(source),
              selected = draft.sourceKeys.includes(key);
            const catalog = AGENT_SOURCES.find(
              (item) =>
                item.id === (source.origin.startsWith("native_") ? "openpond_chat" : source.origin),
            );
            const name =
              source.origin === "native_chat"
                ? "Ponder Pal Chat"
                : source.origin === "native_work"
                  ? "Ponder Pal Work"
                  : (catalog?.name ?? source.name);
            return (
              <label key={key} className="agent-learning-option">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!selected && !["active", "paused"].includes(source.state)}
                  onChange={(event) =>
                    setKeys(
                      event.target.checked
                        ? [...new Set([...draft.sourceKeys, key])]
                        : draft.sourceKeys.filter((item) => item !== key),
                    )
                  }
                />
                {catalog ? <img src={catalog.icon} alt="" /> : null}
                <span>
                  {name}
                  <small>
                    {source.sourceInstanceId
                      ? source.name === source.origin
                        ? "Local connection"
                        : source.name
                      : source.origin.startsWith("native_")
                        ? "Hosted conversations"
                        : "Uploaded history"}
                  </small>
                </span>
                <small>{source.state}</small>
              </label>
            );
          })}
          {!sources.length ? (
            <p role="status">
              {loading
                ? "Fetching source agents…"
                : "Connect or import an agent into this Project first."}
            </p>
          ) : null}
        </div>
        <p>
          Paused agents can use uploaded conversations. Selecting them leaves collection paused.
        </p>
      </fieldset>
      <fieldset>
        <legend>Evaluation rubrics</legend>
        {draft.configurationId ? (
          <p>
            The training configuration pins the task definition and its rubrics. Choose grader
            selection in Preparation.
          </p>
        ) : (
          <>
            <label className="agent-learning-check">
              <input
                type="checkbox"
                disabled={!graders.length}
                checked={
                  graders.length > 0 && graders.every((item) => draft.graderIds.includes(item.id))
                }
                onChange={(event) =>
                  onChange({
                    ...draft,
                    graderIds: event.target.checked ? graders.map((item) => item.id) : [],
                  })
                }
              />
              Select all <small>({draft.graderIds.length} selected)</small>
            </label>
            <div className="agent-learning-options" aria-label="Evaluation rubrics">
              {graders.map((grader) => (
                <label key={`${grader.id}:${grader.revision}`} className="agent-learning-option">
                  <input
                    type="checkbox"
                    checked={draft.graderIds.includes(grader.id)}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        graderIds: event.target.checked
                          ? [...draft.graderIds, grader.id]
                          : draft.graderIds.filter((id) => id !== grader.id),
                      })
                    }
                  />
                  <span>
                    {grader.name}
                    <small>Version {grader.revision}</small>
                  </span>
                </label>
              ))}
              {!graders.length ? (
                <p role="status">
                  {loading
                    ? "Fetching evaluation rubrics…"
                    : "No owned evaluation rubrics are available."}
                </p>
              ) : null}
            </div>
            {draft.definition && !draft.graderIds.length ? (
              <p>The saved task definition and rubrics remain unchanged.</p>
            ) : null}
            <label>
              Existing task definition
              <select
                value={draft.definition?.id ?? ""}
                onChange={(event) => {
                  const definition = options?.definitions.find(
                    (item) => item.id === event.target.value,
                  );
                  onChange({
                    ...draft,
                    definition: definition
                      ? {
                          id: definition.id,
                          revision: definition.revision,
                          contentHash: definition.contentHash,
                        }
                      : null,
                    graderIds: [],
                  });
                }}
              >
                <option value="">Select a definition or choose rubrics above</option>
                {draft.definition &&
                !options?.definitions.some((item) => item.id === draft.definition?.id) ? (
                  <option value={draft.definition.id}>Saved task definition</option>
                ) : null}
                {options?.definitions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} (version {item.revision})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Minimum verified score
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={draft.minimumScore}
            onChange={(event) => onChange({ ...draft, minimumScore: Number(event.target.value) })}
          />
        </label>
      </fieldset>
    </>
  );
}
