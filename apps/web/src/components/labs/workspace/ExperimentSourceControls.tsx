import { DropdownSelect } from "../../DropdownSelect";
import { ErrorToast } from "../../common/ErrorToast";
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
        <DropdownSelect
          label="Execution selection"
          value={draft.mode}
          floating
          options={[
            { value: "model", label: "Model only" },
            { value: "model_harness", label: "Model + Harness" },
            { value: "model_harness_profile", label: "Model + Harness + Profile" },
          ]}
          onChange={(value) =>
            patch({
              mode: value as ExperimentSetupDraft["mode"],
              targetId: "model",
              sourceId: "",
              profileChoiceId: "",
            })
          }
        />
      </label>
      {draft.mode === "model_harness" ? (
        <label>
          Released Harness
          <DropdownSelect
            label="Released Harness"
            searchable
            floating
            value={
              draft.sourceId ||
              (api.location === "hosted" && sources.selected?.target.kind === "agent"
                ? `target:${draft.targetId}`
                : "")
            }
            options={[
              { value: "", label: "Choose released Harness" },
              ...(api.location === "local"
                ? (sources.local.data?.harnesses ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  }))
                : [
                    ...(sources.retainedHostedSource &&
                    !sources.hostedHarnesses.some((item) => item.id === draft.sourceId)
                      ? [
                          {
                            value: draft.sourceId,
                            label: `Retained Harness · ${sources.retainedHostedSource.harnessRelease.id}`,
                          },
                        ]
                      : []),
                    ...sources.hostedHarnesses.map((item) => ({
                      value: item.id,
                      label: item.name,
                      disabled: !item.ready,
                      description: item.ready ? undefined : (item.reason ?? undefined),
                    })),
                    ...standalone.map((item, index) => ({
                      value: `target:${item.id}`,
                      label: item.name,
                      description: "Project target",
                      separatorBefore: index === 0,
                    })),
                  ]),
            ]}
            onChange={(value) =>
              patch(
                value.startsWith("target:")
                  ? { sourceId: "", targetId: value.slice(7) }
                  : { sourceId: value, targetId: "" },
              )
            }
          />
        </label>
      ) : null}
      {draft.mode === "model_harness_profile" ? (
        <label>
          Released Profile evaluation
          <DropdownSelect
            label="Released Profile evaluation"
            searchable
            floating
            value={
              api.location === "local"
                ? (sources.profile?.id ?? draft.profileChoiceId)
                : draft.targetId
            }
            options={[
              { value: "", label: "Choose compatible Profile evaluation" },
              ...(api.location === "local" ? sources.compatibleProfiles : profiles).map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(value) =>
              patch(api.location === "local" ? { profileChoiceId: value } : { targetId: value })
            }
          />
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
        <ErrorToast error={sources.local.error.message}>
          <button type="button" onClick={() => void sources.local.refetch()}>
            Retry source discovery
          </button>
        </ErrorToast>
      ) : null}
      {sources.unavailable ? <ErrorToast error={sources.unavailable} /> : null}
      {api.location === "hosted" && draft.mode === "model_harness" ? (
        <>
          {sources.hosted.isPending ? (
            <p role="status">Loading published Harness sources…</p>
          ) : null}
          {sources.hosted.error ? (
            <ErrorToast error={sources.hosted.error.message}>
              <button type="button" onClick={() => void sources.hosted.refetch()}>
                Retry source discovery
              </button>
            </ErrorToast>
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
