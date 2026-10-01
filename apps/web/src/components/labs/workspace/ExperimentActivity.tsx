import { useQuery } from "@tanstack/react-query";
import { LocalExperimentRecordPageSchema } from "@openpond/contracts";
import type { OpenPondExperimentsClient } from "openpond-sdk/experiments";
import { LoaderCircle } from "lucide-react";
import { PageChromeActivity } from "../../app-shell/PageChrome";
import { localRequest } from "./local-workspace-api";
import type { WorkspaceApi } from "./workspace-api";
import type { ModelsRoute } from "../models-route";

type Activity = { ids: string[]; more: boolean };
type HostedPage = Awaited<ReturnType<OpenPondExperimentsClient["list"]>>;
/** Each status is filtered by the authorized server before paging. */
export function ExperimentActivity({
  api,
  route,
  navigate,
}: {
  api: WorkspaceApi;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
}) {
  const activity = useQuery<Activity>({
    queryKey: ["experiment-activity", api.key],
    staleTime: 4000,
    refetchInterval: 8000,
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        (["running", "queued", "cancelling"] as const).map(async (status) => {
          const query = { status, limit: 1 };
          if (api.location === "local") {
            const page = await localRequest(
              api,
              LocalExperimentRecordPageSchema,
              "list",
              query,
              signal,
            );
            return { ids: page.items.map((item) => item.id), more: Boolean(page.nextCursor) };
          }
          const page = await api.request<HostedPage>("experiments", query, signal);
          return { ids: page.items.map((item) => item.summary.id), more: Boolean(page.nextCursor) };
        }),
      );
      return { ids: [...new Set(pages.flatMap((page) => page.ids))], more: pages.some((page) => page.more) };
    },
  });
  const ids = activity.data?.ids ?? [];
  const label = activity.error
    ? "Experiment activity unavailable"
    : activity.isPending
      ? "Loading Experiment activity…"
      : ids.length
        ? `${ids.length}${activity.data?.more ? "+" : ""} active ${ids.length === 1 && !activity.data?.more ? "Experiment" : "Experiments"}`
        : "No running Experiments";
  return (
    <PageChromeActivity>
      <button
        type="button"
        className="evaluation-model-badge evaluation-activity"
        title={`${api.location === "local" ? "On this Desktop" : "Hosted workspace"} · ${api.projectId ? "Selected Project" : "All Projects"}`}
        aria-label={label}
        onClick={() => {
          if (activity.error) {
            void activity.refetch();
            return;
          }
          if (!ids[0]) return;
          navigate({
            ...route,
            page: "experiments",
            resourceId: ids[0],
            detailTab: "overview",
            collection: "default",
            datasetKind: undefined,
            revision: undefined,
            contentHash: undefined,
            executionId: null,
            passId: null,
            query: "",
            after: null,
          });
        }}
        disabled={activity.isPending || (!activity.error && !ids.length)}
      >
        {ids.length && !activity.error ? (
          <LoaderCircle size={14} className="evaluation-activity-spinner" aria-hidden="true" />
        ) : null}
        {label}
      </button>
    </PageChromeActivity>
  );
}
