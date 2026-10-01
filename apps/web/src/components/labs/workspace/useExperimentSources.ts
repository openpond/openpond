import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import { LocalExperimentSourceChoicesSchema } from "@openpond/contracts";
import type { Inventory, WorkspaceApi } from "./workspace-api";
import type { ExperimentSetupDraft, ExperimentSetupDefinition } from "./EvaluationSetupState";
import { ExperimentHarnessCatalogSchema } from "openpond-sdk/experiments";

export function useExperimentSources(
  api: WorkspaceApi,
  inventory: Inventory | null,
  draft: ExperimentSetupDraft,
  existing: ExperimentSetupDefinition | null,
) {
  const local = useQuery({
    queryKey: ["evaluation-workspace", api.key, "localSources"],
    enabled: api.location === "local",
    queryFn: async ({ signal }) =>
      LocalExperimentSourceChoicesSchema.parse(await api.local("sourceChoices", {}, signal)),
  });
  const hosted = useInfiniteQuery({
    queryKey: ["evaluation-workspace", api.key, "harnessSources"],
    enabled: api.location === "hosted" && draft.mode === "model_harness",
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      ExperimentHarnessCatalogSchema.parse(
        await api.request("harnessSources", { cursor: pageParam }, signal),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const hostedHarnesses =
    hosted.data?.pages
      .flatMap((page) => page.items)
      .map((item) => ({ ...item, id: `harness-${item.source.harnessRelease.contentHash}` })) ?? [];
  const targets =
    inventory?.projects.projects.find((item) => item.id === api.projectId)?.content.targets ?? [];
  const selected = targets.find((item) => item.id === draft.targetId);
  const saved = existing?.request.policy;
  const agent =
    api.location === "local"
      ? local.data?.harnesses.find((item) => item.id === draft.sourceId)
      : undefined;
  const hostedAgent =
    api.location === "hosted"
      ? hostedHarnesses.find((item) => item.id === draft.sourceId && item.ready)
      : undefined;
  // A retained run provides exact pins, not execution permission. Hosted
  // admission reauthorizes its closure even when it is on a later catalog page.
  const retainedHostedSource =
    api.location === "hosted" &&
    saved?.kind === "hosted_chat" &&
    saved.harness &&
    draft.sourceId === `harness-${saved.harness.harnessRelease.contentHash}` &&
    !hostedHarnesses.some((item) => item.id === draft.sourceId)
      ? saved.harness
      : undefined;
  const compatibleProfiles =
    local.data?.profiles.filter(
      (item) =>
        item.taskset.id === draft.release?.id &&
        item.taskset.contentHash === draft.release.contentHash,
    ) ?? [];
  const profile =
    api.location === "local"
      ? compatibleProfiles.find(
          (item) =>
            item.id === draft.profileChoiceId ||
            (!draft.profileChoiceId &&
              saved?.kind === "hosted_harness" &&
              item.profileRef.repositoryId === saved.profileRepositoryId &&
              item.profileRef.profileId === saved.source.profileId &&
              item.definitionHash === saved.source.definitionHash &&
              contentHash(item.harnessRelease) === contentHash(saved.source.harnessRelease)),
        )
      : undefined;
  const harnessSource =
    draft.mode === "model_harness"
      ? api.location === "local"
        ? agent?.source
        : (hostedAgent?.source ??
          retainedHostedSource ??
          (selected?.target.kind === "agent" ? selected.target.source : undefined))
      : undefined;
  const profileTarget =
    draft.mode === "model_harness_profile" && selected?.target.kind === "harness"
      ? selected.target
      : undefined;
  const unavailable =
    draft.mode === "model_harness" && !harnessSource
      ? "The exact Harness is unavailable or unsupported in this account, workspace and execution location. Choose an authorized released Harness."
      : draft.mode === "model_harness_profile" &&
          (api.location === "local" ? !profile : !profileTarget)
        ? "The exact Profile composition is unavailable or incompatible with this Dataset. Choose its compatible released Profile evaluation."
        : null;
  return {
    local,
    hosted,
    hostedHarnesses,
    retainedHostedSource,
    targets,
    selected,
    compatibleProfiles,
    profile,
    profileTarget,
    harnessSource,
    unavailable,
    saved,
  };
}
