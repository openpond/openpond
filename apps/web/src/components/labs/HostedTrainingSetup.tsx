import { useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { contentHash } from "@openpond/harness";
import {
  HostedTrainingSetupCatalogSchema,
  type HostedTrainingSetupCatalog,
  type TrainingHandoffOrigin,
} from "openpond-sdk/post-training";
import {
  TrainingPreparationReceiptSchema,
  type TrainingPreparationReceipt,
  type TrainingPreparationRequest,
} from "openpond-sdk/training";
import {
  createHostedLearningPolicyContent,
  hostedLearningPolicyDefaults,
  learningRef,
} from "openpond-sdk/learning";
import { useDraftNavigation, type DraftEditorHandle } from "./useDraftNavigation";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import {
  HostedTrainingEvaluationChoices,
  emptyHostedEvalChoices,
  hostedSetupAttachment,
} from "./HostedTrainingEvaluationChoices";
export function HostedTrainingSetup({
  connection,
  teamId,
  actorId,
  configurationId,
  projectId,
  initialOrigin,
  retainOperation,
  editorRef,
  onClose,
  onOpenJob,
  onOpenPolicy,
}: {
  connection: ClientConnection;
  teamId: string;
  actorId: string;
  configurationId?: string;
  projectId: string | null;
  initialOrigin?: TrainingHandoffOrigin;
  retainOperation: (
    action: string,
    intent: unknown,
  ) => Promise<{ id: string; acknowledge: () => Promise<void> }>;
  editorRef?: Ref<DraftEditorHandle>;
  onClose: () => void;
  onOpenJob: (id: string) => void;
  onOpenPolicy: (id: string) => void;
}) {
  const selectedConfiguration = initialOrigin?.configurationId ?? configurationId;
  const scope = JSON.stringify([
    connection.serverUrl,
    connection.token,
    teamId,
    actorId,
    projectId,
    selectedConfiguration,
    initialOrigin?.contentHash,
  ]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = "unmounted";
    };
  }, [scope]);
  const [retained, setRetained] = useState<{
      scope: string;
      catalog: HostedTrainingSetupCatalog;
    } | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(false),
    [batchId, setBatchId] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [name, setName] = useState("Training run"),
    [budget, setBudget] = useState("1"),
    [daily, setDaily] = useState("1"),
    [minimum, setMinimum] = useState("1"),
    [maxBatch, setMaxBatch] = useState("1"),
    [cooldown, setCooldown] = useState("0"),
    [retries, setRetries] = useState("0"),
    [backlog, setBacklog] = useState("10000"),
    [trigger, setTrigger] = useState<"approved_count" | "nightly">("approved_count"),
    [localTime, setLocalTime] = useState("02:00"),
    [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [evals, setEvals] = useState(emptyHostedEvalChoices),
    [prepared, setPrepared] = useState<{
      scope: string;
      receipt: TrainingPreparationReceipt;
    } | null>(null);
  const requests = useRef(new Map<string, unknown>());
  const catalog = retained?.scope === scope ? retained.catalog : null,
    receipt = prepared?.scope === scope ? prepared.receipt : null;
  const formIdentity = JSON.stringify({
    keep,
    batchId,
    sourceId,
    name,
    budget,
    daily,
    minimum,
    maxBatch,
    cooldown,
    retries,
    backlog,
    trigger,
    localTime,
    timeZone,
    evals,
  });
  const pristine = useRef<string | null>(null);
  useEffect(() => {
    if (catalog && pristine.current === null) pristine.current = formIdentity;
  }, [catalog, formIdentity]);
  const guard = useDraftNavigation({
    name: "training setup",
    dirty: !!pristine.current && pristine.current !== formIdentity,
    busy,
    onLeave: onClose,
  });
  useImperativeHandle(editorRef, () => ({
    requestClose: () => {
      void guard.requestLeave(onClose);
    },
  }));
  const inputLock =
    busy ||
    !!receipt ||
    requests.current.has(`${scope}:preparation`) ||
    requests.current.has(`${scope}:policy`);
  useEffect(() => {
    let stopped = false;
    setError(null);
    setBusy(false);
    pristine.current = null;
    setBatchId("");
    setSourceId("");
    setName("Training run");
    setEvals(emptyHostedEvalChoices);
    if (!selectedConfiguration) {
      setError("Choose an exact owned training configuration.");
      return;
    }
    if (
      initialOrigin &&
      (initialOrigin.teamId !== teamId || initialOrigin.projectId !== projectId)
    ) {
      setError("Reopen this result in its exact account and Project.");
      return;
    }
    const params = new URLSearchParams({ teamId, configurationId: selectedConfiguration });
    if (projectId) params.set("projectId", projectId);
    void apiFetch(connection, `/v1/training/setup?${params}`)
      .then((raw) => {
        const value = HostedTrainingSetupCatalogSchema.parse(raw);
        if (
          value.teamId !== teamId ||
          value.actorId !== actorId ||
          value.configuration.id !== selectedConfiguration ||
          value.projectId !== projectId
        )
          throw new Error("Training setup returned a different configuration or Project.");
        if (!stopped) {
          setRetained({ scope, catalog: value });
          setBudget(String(value.configuration.trainingSetup.preferredMaximumSpendUsd ?? 1));
          setDaily(String(value.configuration.trainingSetup.preferredMaximumSpendUsd ?? 1));
        }
      })
      .catch((reason) => {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : "Training setup is unavailable.");
      });
    return () => {
      stopped = true;
    };
  }, [
    connection.serverUrl,
    connection.token,
    teamId,
    actorId,
    projectId,
    selectedConfiguration,
    initialOrigin?.contentHash,
    scope,
  ]);
  async function request(action: string, body: unknown) {
    if (activeScope.current !== scope)
      throw new Error("The active account or Project changed. Reopen training setup.");
    const value = await apiFetch(
      connection,
      `/v1/training/setup/${action}?teamId=${encodeURIComponent(teamId)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (activeScope.current !== scope)
      throw new Error("The active account or Project changed. Reopen training setup.");
    return value;
  }
  async function perform(action: "prepare" | "start" | "cancel" | "save-policy" | "start-policy") {
    if (!catalog || busy) return;
    const callScope = scope;
    const fence = () => {
      if (activeScope.current !== callScope)
        throw new Error("The active account or Project changed. Reopen training setup.");
    };
    setBusy(true);
    setError(null);
    try {
      if (action === "prepare") {
        const key = `${scope}:preparation`;
        let body = requests.current.get(key) as TrainingPreparationRequest | undefined;
        const batch = catalog.batches.find((b) => b.id === batchId);
        if (!batch) throw new Error("Select a sealed, approved reward-training batch.");
        const intent = {
          teamId,
          projectId,
          configuration: {
            id: catalog.configuration.id,
            revision: catalog.configuration.revision,
            etag: catalog.configuration.etag,
          },
          batch: learningRef(batch),
          name: name.trim(),
          maximumSpendUsd: Number(budget),
          origin: initialOrigin ?? null,
        };
        const retainedOp = await retainOperation("training:prepare", intent);
        fence();
        body ??= {
          schemaVersion: "openpond.trainingPreparationRequest.v1",
          teamId,
          projectId,
          configuration: {
            id: catalog.configuration.id,
            expectedRevision: catalog.configuration.revision,
            expectedEtag: catalog.configuration.etag,
          },
          batch: learningRef(batch),
          name: name.trim(),
          maximumSpendUsd: Number(budget),
          operationId: retainedOp.id,
          ...(initialOrigin ? { origin: initialOrigin } : {}),
        };
        requests.current.set(key, body);
        const value = TrainingPreparationReceiptSchema.parse(await request("prepare", body));
        if (
          value.plan.request.teamId !== teamId ||
          value.plan.request.configuration.id !== catalog.configuration.id
        )
          throw new Error("Prepared inputs belong to another configuration.");
        setPrepared({ scope, receipt: value });
      } else if (action === "start" || action === "cancel") {
        if (!receipt) throw new Error("Review the immutable preparation first.");
        if (action === "start") {
          const attachment = hostedSetupAttachment(evals, catalog, {
            kind: "preparation",
            id: receipt.plan.id,
            revision: receipt.revision,
            contentHash: receipt.plan.contentHash,
          });
          if (attachment) {
            const retainedOp = await retainOperation("training:attach", attachment);
            fence();
            await request("attach", { operationId: retainedOp.id, attachment });
            await retainedOp.acknowledge();
            fence();
          }
        }
        const value = TrainingPreparationReceiptSchema.parse(
          await request(action, {
            id: receipt.plan.id,
            control: {
              teamId,
              planHash: receipt.plan.contentHash,
              expectedRevision: receipt.revision,
            },
          }),
        );
        if (value.plan.contentHash !== receipt.plan.contentHash)
          throw new Error("The preparation changed.");
        setPrepared({ scope, receipt: value });
        if (action === "start" && value.jobId) {
          guard.allowNextNavigation();
          onClose();
          onOpenJob(value.jobId);
        }
        if (action === "cancel") {
          requests.current.delete(`${scope}:preparation`);
          setPrepared(null);
        }
      } else {
        const source = catalog.sources.find((s) => s.id === sourceId);
        if (!source) throw new Error("Select an approved-data source bound to this evaluator.");
        const policyIntent = {
          teamId,
          actorId,
          projectId,
          configurationHash: catalog.configuration.etag,
          source: learningRef(source),
          activate: action === "start-policy",
          settings: {
            minimum,
            maxBatch,
            budget,
            daily,
            cooldown,
            retries,
            backlog,
            trigger,
            localTime,
            timeZone,
          },
          evals,
          origin: initialOrigin ?? null,
        };
        const retainedOp = await retainOperation("training:publish-policy", policyIntent);
        fence();
        const content = createHostedLearningPolicyContent({
          project: catalog.configuration,
          previous: null,
          policyId: `run-plan-${retainedOp.id}`,
          applyModelConfiguration: true,
          sources: [learningRef(source)],
          taskDefinition: source.taskDefinition,
          settings: {
            ...hostedLearningPolicyDefaults(catalog.configuration, null),
            enabled: action === "start-policy",
            scheduled: true,
            humanReviewRequired: true,
            minimumApprovedExamples: Number(minimum),
            maxBatchExamples: Number(maxBatch),
            maxIterationSpendUsd: Number(budget),
            maxDailySpendUsd: Number(daily),
            cooldownSeconds: Number(cooldown),
            maxRetries: Number(retries),
            maxBacklogExamples: Number(backlog),
            trigger:
              trigger === "nightly"
                ? { kind: "nightly", localTime, timeZone }
                : { kind: "approved_count" },
          },
        });
        if (initialOrigin) content.origin = initialOrigin;
        const key = `${scope}:policy`,
          attachment = hostedSetupAttachment(evals, catalog, {
            kind: "policy",
            id: content.id,
            revision: content.revision,
            contentHash: contentHash(content),
          });
        const body = {
          operationId: retainedOp.id,
          command: {
            action: "publish",
            operationId: retainedOp.id,
            kind: "policy",
            expectedRevision: 0,
            content,
          },
          attachment,
        };
        const prior = requests.current.get(key);
        if (prior && contentHash(prior) !== contentHash(body))
          throw new Error(
            "This exact plan has an uncertain retained submission. Retry it without changing inputs.",
          );
        requests.current.set(key, body);
        await request("publish", body);
        await retainedOp.acknowledge();
        fence();
        guard.allowNextNavigation();
        onClose();
        onOpenPolicy(content.id);
      }
    } catch (reason) {
      if (activeScope.current === callScope)
        setError(reason instanceof Error ? reason.message : "Training setup failed.");
    } finally {
      if (activeScope.current === callScope) setBusy(false);
    }
  }
  const setup = catalog?.configuration.trainingSetup;
  const complete =
    setup?.recipe?.method === "grpo" &&
    setup.managedRolloutPlacement === "remote" &&
    !!setup.rewardBindingRef &&
    !!setup.evaluationTasksetRef;
  return (
    <section className="labs-resource-page">
      <h2>Training setup</h2>
      {guard.dialog}
      <button type="button" disabled={busy} onClick={() => void guard.requestLeave(onClose)}>
        Close setup
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {!catalog ? (
        <p role="status">Loading current training configuration…</p>
      ) : (
        <>
          <h3>{catalog.configuration.name}</h3>
          {initialOrigin ? (
            <p>
              Exact completed result {initialOrigin.source.executionId}
              {initialOrigin.source.passId
                ? ` / scoring pass ${initialOrigin.source.passId}`
                : ""}{" "}
              retained. Dataset and graders remain evaluation evidence; choose approved training
              data separately.
            </p>
          ) : null}
          <dl>
            <dt>Starting model</dt>
            <dd>
              {setup?.baseModel?.modelId ??
                catalog.configuration.defaultBaseModel?.modelId ??
                "Choose a starting model"}
            </dd>
            <dt>Method</dt>
            <dd>{setup?.recipe?.method ?? "Select a recipe"}</dd>
            <dt>Reward</dt>
            <dd>{setup?.rewardBindingRef?.id ?? "Select an executable grader"}</dd>
            <dt>Execution</dt>
            <dd>{setup?.managedRolloutPlacement ?? "Select execution placement"}</dd>
            <dt>Validation dataset</dt>
            <dd>{setup?.evaluationTasksetRef?.id ?? "Select independent validation data"}</dd>
          </dl>
          {!complete ? (
            <p>
              Complete the owned GRPO configuration with remote execution, an executable grader and
              published validation dataset before launch. Unsupported methods have no qualified
              hosted optimizer.
            </p>
          ) : null}
          <fieldset disabled={inputLock}>
            <legend>Execution plan</legend>
            <label>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              Keep learning
            </label>
            <p>
              {keep
                ? "Each iteration uses reviewed data, retained configuration and independent acceptance. Daily and iteration ceilings bound work; new runs require sufficient approved examples."
                : "Run once compiles the selected sealed batch and starts one actual optimizer job."}
            </p>
            {keep ? (
              <>
                <label>
                  Approved-data source
                  <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                    <option value="">Select source</option>
                    {catalog.sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    ["minimum", "Minimum approved examples", minimum, setMinimum],
                    ["batch", "Maximum batch examples", maxBatch, setMaxBatch],
                    ["daily", "Daily spending ceiling ($)", daily, setDaily],
                    ["cooldown", "Cooldown seconds", cooldown, setCooldown],
                    ["retries", "Maximum retries", retries, setRetries],
                    ["backlog", "Maximum backlog examples", backlog, setBacklog],
                  ] as const
                ).map(([key, label, value, set]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  Trigger
                  <select
                    value={trigger}
                    onChange={(e) => setTrigger(e.target.value as typeof trigger)}
                  >
                    <option value="approved_count">Approved count</option>
                    <option value="nightly">Nightly</option>
                  </select>
                </label>
                {trigger === "nightly" ? (
                  <>
                    <label>
                      Local time
                      <input
                        type="time"
                        value={localTime}
                        onChange={(e) => setLocalTime(e.target.value)}
                      />
                    </label>
                    <label>
                      Time zone
                      <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
                    </label>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <label>
                  Run name
                  <input maxLength={191} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  Sealed approved training batch
                  <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                    <option value="">Select batch</option>
                    {catalog.batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.id} / {b.examples.length} approved examples
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              {keep ? "Iteration spending ceiling ($)" : "Run spending ceiling ($)"}
              <input
                type="number"
                min="0.000001"
                max="1000000"
                step="any"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
          </fieldset>
          <HostedTrainingEvaluationChoices
            catalog={catalog}
            value={evals}
            onChange={setEvals}
            disabled={busy || requests.current.has(`${scope}:policy`)}
          />
          {receipt ? (
            <section>
              <h3>Reviewed preparation</h3>
              <p>
                Configuration v{receipt.plan.source.modelProject.revision} / batch{" "}
                {receipt.plan.request.batch.id} / ${receipt.plan.request.maximumSpendUsd}
              </p>
              <code>{receipt.plan.contentHash}</code>
              <button type="button" disabled={busy} onClick={() => void perform("start")}>
                Run once
              </button>
              <button type="button" disabled={busy} onClick={() => void perform("cancel")}>
                Discard preparation
              </button>
            </section>
          ) : keep ? (
            <>
              <button
                type="button"
                disabled={busy || !complete}
                onClick={() => void perform("save-policy")}
              >
                Save disabled plan
              </button>
              <button
                type="button"
                disabled={busy || !complete}
                onClick={() => void perform("start-policy")}
              >
                Keep learning
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || !complete}
              onClick={() => void perform("prepare")}
            >
              Review prepared run
            </button>
          )}
        </>
      )}
    </section>
  );
}
