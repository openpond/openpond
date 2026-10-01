import type { ExperimentSetupDraft } from "./EvaluationSetupState";
import type { useExperimentSources } from "./useExperimentSources";
import type { WorkspaceApi } from "./workspace-api";
import { EvaluationCard } from "./EvaluationPresentation";

export function ExperimentSourceControls({
  api,
  draft,
  patch,
  sources,
}: {
  api: WorkspaceApi;
  draft: ExperimentSetupDraft;
  patch: (draft: Partial<ExperimentSetupDraft>) => void;
  sources: ReturnType<typeof useExperimentSources>;
}) {
  const standalone = sources.targets.filter((item) => item.target.kind === "agent");
  const profiles = sources.targets.filter((item) => item.target.kind === "harness");
  return (
    <EvaluationCard title="Execution">
      <label>
        Execution selection
        <select
          value={draft.mode}
          onChange={(event) =>
            patch({
              mode: event.target.value as ExperimentSetupDraft["mode"],
              targetId: "model",
              sourceId: "",
              profileChoiceId: "",
            })
          }
        >
          <option value="model">Model only</option>
          <option value="model_harness">Model + Harness</option>
          <option value="model_harness_profile">Model + Harness + Profile</option>
        </select>
      </label>
      {draft.mode === "model_harness" ? (
        <label>
          Released Harness
          <select
            value={
              draft.sourceId ||
              (api.location === "hosted" && sources.selected?.target.kind === "agent"
                ? `target:${draft.targetId}`
                : "")
            }
            onChange={(event) =>
              patch(
                event.target.value.startsWith("target:")
                  ? { sourceId: "", targetId: event.target.value.slice(7) }
                  : { sourceId: event.target.value, targetId: "" },
              )
            }
          >
            <option value="">Choose released Harness</option>
            {api.location === "local" ? (
              sources.local.data?.harnesses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <>
                <optgroup label="Workspace releases">
                  {sources.retainedHostedSource &&
                  !sources.hostedHarnesses.some((item) => item.id === draft.sourceId) ? (
                    <option value={draft.sourceId}>
                      Retained Harness · {sources.retainedHostedSource.harnessRelease.id}
                    </option>
                  ) : null}
                  {sources.hostedHarnesses.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.ready}>
                      {item.name}
                      {item.ready ? "" : ` · ${item.reason}`}
                    </option>
                  ))}
                </optgroup>
                {standalone.length ? (
                  <optgroup label="Project targets">
                    {standalone.map((item) => (
                      <option key={item.id} value={`target:${item.id}`}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </>
            )}
          </select>
        </label>
      ) : null}
      {draft.mode === "model_harness_profile" ? (
        <label>
          Released Profile evaluation
          <select
            value={
              api.location === "local"
                ? (sources.profile?.id ?? draft.profileChoiceId)
                : draft.targetId
            }
            onChange={(event) =>
              patch(
                api.location === "local"
                  ? { profileChoiceId: event.target.value }
                  : { targetId: event.target.value },
              )
            }
          >
            <option value="">Choose compatible Profile evaluation</option>
            {api.location === "local"
              ? sources.compatibleProfiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))
              : profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
          </select>
        </label>
      ) : null}
      {sources.harnessSource ? (
        <dl>
          <dt>Harness release</dt>
          <dd>
            {sources.harnessSource.harnessRelease.id} ·{" "}
            {sources.harnessSource.harnessRelease.contentHash}
          </dd>
          <dt>Agent snapshot</dt>
          <dd>
            {sources.harnessSource.agentSnapshot.id} ·{" "}
            {sources.harnessSource.agentSnapshot.contentHash}
          </dd>
          <dt>Source package</dt>
          <dd>{sources.harnessSource.sourcePackageHash}</dd>
        </dl>
      ) : null}
      {sources.profile ? (
        <dl>
          <dt>Profile</dt>
          <dd>
            {sources.profile.profileRef.profileId} · {sources.profile.sourceRevision}
          </dd>
          <dt>Harness release</dt>
          <dd>
            {sources.profile.harnessRelease.id} · {sources.profile.harnessRelease.contentHash}
          </dd>
          <dt>Evaluation definition</dt>
          <dd>
            {sources.profile.definitionId} · {sources.profile.definitionHash}
          </dd>
        </dl>
      ) : null}
      {sources.profileTarget ? (
        <dl>
          <dt>Profile</dt>
          <dd>
            {sources.profileTarget.source.profileId} · {sources.profileTarget.source.sourceRevision}
          </dd>
          <dt>Harness release</dt>
          <dd>
            {sources.profileTarget.source.harnessRelease.id} ·{" "}
            {sources.profileTarget.source.harnessRelease.contentHash}
          </dd>
          <dt>Evaluation definition</dt>
          <dd>
            {sources.profileTarget.source.definitionId} ·{" "}
            {sources.profileTarget.source.definitionHash}
          </dd>
        </dl>
      ) : null}
      {sources.unavailable && sources.saved?.kind === "hosted_chat" && sources.saved.harness ? (
        <p>
          Retained Harness: {sources.saved.harness.harnessRelease.id} ·{" "}
          {sources.saved.harness.harnessRelease.contentHash}. Source package:{" "}
          {sources.saved.harness.sourcePackageHash}.
        </p>
      ) : null}
      {sources.unavailable && sources.saved?.kind === "hosted_harness" ? (
        <p>
          Retained Profile: {sources.saved.source.profileId} · {sources.saved.source.sourceRevision}
          . Harness: {sources.saved.source.harnessRelease.id} ·{" "}
          {sources.saved.source.harnessRelease.contentHash}.
        </p>
      ) : null}
      {api.location === "local" && sources.local.isPending ? (
        <p role="status">Loading authorized local sources…</p>
      ) : null}
      {sources.local.error ? (
        <p role="alert">
          {sources.local.error.message}
          <button type="button" onClick={() => void sources.local.refetch()}>
            Retry source discovery
          </button>
        </p>
      ) : null}
      {sources.unavailable ? <p role="alert">{sources.unavailable}</p> : null}
      {api.location === "hosted" && draft.mode === "model_harness" ? (
        <>
          {sources.hosted.isPending ? (
            <p role="status">Loading published Harness sources…</p>
          ) : null}
          {sources.hosted.error ? (
            <p role="alert">
              {sources.hosted.error.message}
              <button type="button" onClick={() => void sources.hosted.refetch()}>
                Retry source discovery
              </button>
            </p>
          ) : null}
          {sources.hosted.hasNextPage ? (
            <button
              type="button"
              disabled={sources.hosted.isFetchingNextPage}
              onClick={() => void sources.hosted.fetchNextPage()}
            >
              Load more Harness sources
            </button>
          ) : null}
          {!sources.hosted.isPending && !sources.hosted.error && !sources.hostedHarnesses.length ? (
            <p>Publish a complete released Harness source in this workspace to select it here.</p>
          ) : null}
        </>
      ) : null}
    </EvaluationCard>
  );
}
