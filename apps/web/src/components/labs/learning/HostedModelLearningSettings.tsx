import { useEffect, useRef, useState } from "react";
import {
  createHostedLearningPolicyContent,
  hostedLearningPolicyDefaults,
  supportsRecurringModelTraining,
  learningRef,
  sameLearningRef,
  type LearningPolicy,
  type LearningRevisionRef,
  type LearningSource,
  type LearningCommand,
} from "openpond-sdk/learning";
import type { HostedModelProjectSummary } from "openpond-sdk/model-projects";
import { ApiRequestError } from "../../../api/api-client";
import type {
  createHostedModelLearningApi,
  HostedModelLearningSources,
} from "../../../api/model-learning-api";
import { DropdownSelect } from "../../DropdownSelect";
import { AppDialog } from "../../dialogs/AppDialog";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningError, LearningPager } from "./LearningFields";

type Client = ReturnType<typeof createHostedModelLearningApi>;
export function HostedModelLearningSettings({
  client,
  project,
  policy,
  onClose,
}: {
  client: Client;
  project: HostedModelProjectSummary;
  policy: LearningPolicy | null;
  onClose: () => void;
}) {
  const [id] = useState(() => policy?.id ?? `policy-${crypto.randomUUID()}`);
  const [defaults] = useState(() => hostedLearningPolicyDefaults(project, policy));
  const [enabled, setEnabled] = useState(defaults.enabled && policy?.trigger.kind !== "manual");
  const [triggerKind, setTriggerKind] = useState<LearningPolicy["trigger"]["kind"]>(
    policy?.trigger.kind ?? "nightly",
  );
  const [localTime, setLocalTime] = useState(
    policy?.trigger.kind === "nightly" ? policy.trigger.localTime : "20:00",
  );
  const [timeZone, setTimeZone] = useState(
    policy?.trigger.kind === "nightly"
      ? policy.trigger.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [timeZones] = useState(() =>
    [...new Set([timeZone, "UTC", ...Intl.supportedValuesOf("timeZone")])]
      .sort()
      .map((value) => ({ value, label: value })),
  );
  const [applyModel, setApplyModel] = useState(!policy);
  const [human, setHuman] = useState(defaults.humanReviewRequired);
  const [sources, setSources] = useState(policy?.sources ?? []);
  const [definition, setDefinition] = useState<LearningRevisionRef | null>(
    policy?.taskDefinition ?? null,
  );
  const [fields, setFields] = useState({
    interval: String(defaults.intervalSeconds / 60),
    minimum: String(defaults.minimumApprovedExamples),
    batch: String(defaults.maxBatchExamples),
    spend: String(defaults.maxIterationSpendUsd),
    daily: String(defaults.maxDailySpendUsd),
    cooldown: String(defaults.cooldownSeconds / 60),
    retries: String(defaults.maxRetries),
    backlog: String(defaults.maxBacklogExamples),
  });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [after, setAfter] = useState<string | undefined>();
  const [catalog, setCatalog] = useState<{
    after?: string;
    data: HostedModelLearningSources;
  } | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const pending = useRef<LearningCommand | null>(null);
  const active = useRef(false);
  useEffect(() => {
    let stopped = false;
    void client.sources(after).then(
      (data) => {
        if (!stopped) {
          setCatalog({ after, data });
          setCatalogError(null);
        }
      },
      (failure) => {
        if (!stopped) setCatalogError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      stopped = true;
    };
  }, [client, after]);
  const current = catalog && catalog.after === after ? catalog.data : null;
  const method = applyModel ? project.trainingSetup.method : policy?.training.method;
  const recurringSupported = supportsRecurringModelTraining(method);
  const binding = applyModel ? project.trainingSetup.rewardBindingRef : policy?.rewardBinding;
  function select(source: LearningSource) {
    const selected = sources.some((ref) => ref.id === source.id);
    setSources(
      selected ? sources.filter((ref) => ref.id !== source.id) : [...sources, learningRef(source)],
    );
    setDefinition(selected && sources.length === 1 ? null : (definition ?? source.taskDefinition));
    setDirty(true);
  }
  async function save() {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!pending.current) {
        if (!definition || !sources.length || !binding)
          throw new Error("Select task sources and a Model Reward before saving.");
        const content = createHostedLearningPolicyContent({
          project,
          previous: policy,
          policyId: id,
          applyModelConfiguration: applyModel,
          sources,
          taskDefinition: definition,
          settings: {
            enabled:
              triggerKind === "manual" ? (policy?.enabled ?? false) : recurringSupported && enabled,
            scheduled: recurringSupported && triggerKind !== "manual",
            humanReviewRequired: human,
            intervalSeconds: Number(fields.interval) * 60,
            trigger:
              triggerKind === "nightly"
                ? { kind: "nightly", localTime, timeZone }
                : triggerKind === "schedule"
                  ? { kind: "schedule", intervalSeconds: Number(fields.interval) * 60 }
                  : triggerKind === "approved_count"
                    ? { kind: "approved_count" }
                    : triggerKind === "manual"
                      ? { kind: "manual" }
                      : undefined,
            minimumApprovedExamples: Number(fields.minimum),
            maxBatchExamples: Number(fields.batch),
            maxIterationSpendUsd: Number(fields.spend),
            maxDailySpendUsd: Number(fields.daily),
            cooldownSeconds: Number(fields.cooldown) * 60,
            maxRetries: Number(fields.retries),
            maxBacklogExamples: Number(fields.backlog),
          },
        });
        if (triggerKind === "upstream_accepted" && policy?.trigger.kind === "upstream_accepted") {
          content.trigger = policy.trigger;
          content.automation.train = policy.automation.train;
        }
        pending.current = {
          action: "publish",
          kind: "policy",
          operationId: crypto.randomUUID(),
          expectedRevision: policy?.revision ?? 0,
          content,
        };
      }
      await client.command(pending.current);
      pending.current = null;
      setDirty(false);
      return true;
    } catch (failure) {
      if (
        failure instanceof ApiRequestError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        ![408, 429].includes(failure.status)
      )
        pending.current = null;
      setError(failure instanceof Error ? failure.message : "Unable to save learning settings.");
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const guard = useDraftNavigation({ name: "learning settings", dirty, busy, save });
  return (
    <>
      <AppDialog
        ariaLabel="Continual learning settings"
        className="labs-rename-dialog learning-workspace hosted-learning-settings"
        backdropClassName="labs-rename-backdrop"
        dismissDisabled={busy}
        onClose={() => {
          void guard.requestLeave(onClose);
        }}
      >
        <h2>Continual learning settings</h2>
        <p>
          Train {project.name} from admitted, unused evidence. Saving settings does not start an
          extra run.
        </p>
        <LearningError error={error ?? catalogError} />
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (await save()) {
              guard.allowNextNavigation();
              onClose();
            }
          }}
        >
          <fieldset disabled={busy || Boolean(pending.current)} onChange={() => setDirty(true)}>
            <label>
              <input
                type="checkbox"
                checked={recurringSupported && enabled}
                disabled={!recurringSupported || triggerKind === "manual"}
                onChange={(event) => setEnabled(event.target.checked)}
              />{" "}
              Enable learning
            </label>
            {!recurringSupported ? (
              <p>Recurring training is unavailable for this method. Run one reviewed stage.</p>
            ) : method === "sft" ? (
              <p>Each recurring SFT cycle trains a fresh LoRA from the pinned base model.</p>
            ) : null}
            <fieldset>
              <legend>Example review and admission</legend>
              <DropdownSelect
                label="Example admission"
                value={human ? "human" : "qualified_automatic"}
                options={[
                  { value: "human", label: "Human approval before training" },
                  {
                    value: "qualified_automatic",
                    label: "Qualified automatic admission",
                    disabled: human,
                    description: "Requires an existing qualified policy; cannot be enabled here.",
                  },
                ]}
                onChange={(value) => {
                  setHuman(value === "human");
                  setDirty(true);
                }}
              />
              <p>
                Grader scores measure quality; human admission gives ordinary evidence permission to
                train. Newly authored Dataset rows must first be submitted as evidence. Qualified
                conversation policies handle independently verified admissions and send exceptions
                to Inbox.
              </p>
            </fieldset>
            <fieldset>
              <legend>Candidate decision</legend>
              <p>
                Owner approval follows training and independent comparison. This form does not
                authorize automatic acceptance or serving activation. Conversation exception and
                activation controls belong to that conversation policy.
              </p>
            </fieldset>
            {policy ? (
              <label>
                <input
                  type="checkbox"
                  checked={applyModel}
                  onChange={(event) => setApplyModel(event.target.checked)}
                />{" "}
                Use the Model’s current training configuration
              </label>
            ) : null}
            <fieldset>
              <legend>Task sources</legend>
              {!current && !catalogError ? <p>Loading sources…</p> : null}
              {current ? (
                <DropdownSelect
                  label="Task source"
                  searchable
                  floating
                  value="__choose__"
                  triggerContent={
                    sources.length
                      ? sources
                          .map(
                            (ref) =>
                              current.sources.items.find((item) => item.id === ref.id)?.name ??
                              ref.id,
                          )
                          .join(", ")
                      : "Choose task sources"
                  }
                  options={[
                    { value: "__choose__", label: "Choose a task source", disabled: true },
                    ...current.sources.items.map((source) => {
                      const format = current.definitions.find((item) =>
                        sameLearningRef(learningRef(item), source.taskDefinition),
                      );
                      const selected = sources.find((ref) => ref.id === source.id);
                      const compatible = Boolean(
                        binding &&
                        format &&
                        sameLearningRef(binding, format.rewardBinding) &&
                        (!definition || sameLearningRef(definition, source.taskDefinition)),
                      );
                      return {
                        value: source.id,
                        label: `${selected ? "Remove" : "Add"} ${source.name}`,
                        disabled: !selected && (!source.enabled || !compatible),
                        description:
                          selected && selected.revision !== source.revision
                            ? `Using saved revision ${selected.revision}; remove and add again to update.`
                            : !compatible
                              ? "Different task format or Reward."
                              : undefined,
                      };
                    }),
                  ]}
                  onChange={(id) => {
                    const source = current.sources.items.find((item) => item.id === id);
                    if (source) select(source);
                  }}
                />
              ) : null}
              {sources.length ? (
                <p>
                  {sources
                    .map(
                      (ref) =>
                        current?.sources.items.find((item) => item.id === ref.id)?.name ?? ref.id,
                    )
                    .join(", ")}
                </p>
              ) : null}
              <p>
                {sources.length} sources selected.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setSources([]);
                    setDefinition(null);
                    setDirty(true);
                  }}
                >
                  Clear selection
                </button>
              </p>
              {catalogError ? (
                <button
                  type="button"
                  className="training-button secondary"
                  onClick={() => {
                    void client.sources(after).then(
                      (data) => {
                        setCatalog({ after, data });
                        setCatalogError(null);
                      },
                      (failure) =>
                        setCatalogError(
                          failure instanceof Error ? failure.message : "Unable to refresh sources.",
                        ),
                    );
                  }}
                >
                  Retry sources
                </button>
              ) : null}
              <LearningPager
                after={after}
                next={current?.sources.nextCursor}
                onPage={(value) => setAfter(value ?? undefined)}
              />
            </fieldset>
            <fieldset>
              <legend>Training schedule</legend>
              <DropdownSelect
                label="Training schedule"
                disabled={!recurringSupported}
                value={triggerKind}
                options={[
                  { value: "nightly", label: "Every night" },
                  { value: "approved_count", label: "When enough approved tasks are ready" },
                  { value: "schedule", label: "Check at an interval" },
                  ...(triggerKind === "manual"
                    ? [{ value: "manual", label: "No recurring cadence selected", disabled: true }]
                    : []),
                  ...(policy?.trigger.kind === "upstream_accepted"
                    ? [
                        {
                          value: "upstream_accepted",
                          label: "After the configured upstream Model is accepted",
                        },
                      ]
                    : []),
                ]}
                onChange={(value) => {
                  setTriggerKind(value as typeof triggerKind);
                  setDirty(true);
                }}
              />
              {triggerKind === "nightly" ? (
                <>
                  <label>
                    Local check time
                    <input
                      type="time"
                      value={localTime}
                      onChange={(event) => setLocalTime(event.target.value)}
                    />
                  </label>
                  <label>
                    Timezone
                    <DropdownSelect
                      label="Learning timezone"
                      searchable
                      floating
                      value={timeZone}
                      options={timeZones}
                      onChange={(value) => {
                        setTimeZone(value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <p>
                    Checks daily at {localTime} · {timeZone}. Training waits for at least{" "}
                    {fields.minimum} approved, unused examples and available budget and capacity.
                  </p>
                </>
              ) : triggerKind === "approved_count" ? (
                <p>Checks when at least {fields.minimum} admitted, unused examples are ready.</p>
              ) : triggerKind === "manual" ? (
                <p>No recurring cadence selected. One-off training uses Run.</p>
              ) : triggerKind === "schedule" ? (
                <p>
                  Checks every {fields.interval} minutes for at least {fields.minimum} approved,
                  unused examples.
                </p>
              ) : triggerKind === "upstream_accepted" ? (
                <p>Checks after the configured upstream Model is accepted.</p>
              ) : null}
            </fieldset>
            {(Object.keys(fields) as Array<keyof typeof fields>)
              .filter((key) => key !== "interval" || triggerKind === "schedule")
              .map((key) => (
                <label key={key}>
                  {
                    {
                      interval: "Check interval (minutes)",
                      minimum: "Minimum approved examples",
                      batch: "Maximum examples per batch",
                      spend: "Maximum spend per iteration ($)",
                      daily: "Maximum daily spend ($)",
                      cooldown: "Cooldown (minutes)",
                      retries: "Automatic retries",
                      backlog: "Maximum backlog",
                    }[key]
                  }
                  <input
                    type="number"
                    value={fields[key]}
                    min="0"
                    step={key === "spend" || key === "daily" ? "0.01" : "1"}
                    onChange={(event) =>
                      setFields((value) => ({ ...value, [key]: event.target.value }))
                    }
                  />
                </label>
              ))}
          </fieldset>
          <div className="model-build-actions">
            <button type="submit" className="training-button" disabled={busy}>
              {busy ? "Saving…" : pending.current ? "Retry save" : "Save settings"}
            </button>
            <button
              type="button"
              className="training-button secondary"
              disabled={busy}
              onClick={() => {
                void guard.requestLeave(onClose);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </AppDialog>
      {guard.dialog}
    </>
  );
}
