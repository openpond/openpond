import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { BootstrapPayload, CloudProject, CloudWorkItem, CloudWorkItemDetail } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { ShowAppToast } from "../app/app-state";
import { projectSelectionKey, type AppView } from "../lib/app-models";
import { parseComposerSlashCommandPrompt } from "../lib/composer-slash-commands";
import {
  approveCreatePipelineSnapshot,
  buildHostedCloudWorkCreatePipelineRequest,
  buildInitialCreatePipelineSnapshot,
  cancelCreatePipelineSnapshot,
  reviseCreatePipelineSnapshot,
} from "../lib/create-pipeline-request";

type UseCloudWorkItemsInput = {
  bootstrap: BootstrapPayload | null;
  connection: ClientConnection | null;
  cloudProjectById: Map<string, CloudProject>;
  cloudProjectIdsByTeam: Map<string, string[]>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setError: Dispatch<SetStateAction<string | null>>;
  showToast: ShowAppToast;
};

export function useCloudWorkItems({
  bootstrap,
  connection,
  cloudProjectById,
  cloudProjectIdsByTeam,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setView,
  setError,
  showToast,
}: UseCloudWorkItemsInput) {
  const [cloudWorkItems, setCloudWorkItems] = useState<CloudWorkItem[]>([]);
  const [selectedCloudWorkItemId, setSelectedCloudWorkItemId] = useState<string | null>(null);
  const [cloudWorkItemDetail, setCloudWorkItemDetail] = useState<CloudWorkItemDetail | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  const selectedCloudWorkItem = useMemo(
    () => cloudWorkItems.find((workItem) => workItem.id === selectedCloudWorkItemId) ?? null,
    [cloudWorkItems, selectedCloudWorkItemId],
  );

  useEffect(() => {
    if (!connection || cloudProjectIdsByTeam.size === 0) {
      setCloudWorkItems([]);
      setCloudWorkItemDetail(null);
      setCloudError(null);
      return undefined;
    }

    let cancelled = false;
    setCloudLoading(true);
    void Promise.all(
      Array.from(cloudProjectIdsByTeam.entries()).map(([teamId, projectIds]) =>
        api.cloudWorkItems(connection, { teamId, projectIds, limit: 100 }),
      ),
    )
      .then((responses) => {
        if (cancelled) return;
        const byId = new Map<string, CloudWorkItem>();
        for (const response of responses) {
          for (const workItem of response.workItems) byId.set(workItem.id, workItem);
        }
        const next = [...byId.values()].sort(
          (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
        setCloudWorkItems(next);
        setCloudError(null);
      })
      .catch((loadError) => {
        if (!cancelled) setCloudError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudProjectIdsByTeam, connection]);

  useEffect(() => {
    if (!connection || !selectedCloudWorkItem) {
      setCloudWorkItemDetail(null);
      return undefined;
    }

    let cancelled = false;
    setCloudLoading(true);
    void api
      .cloudWorkItem(connection, selectedCloudWorkItem.id, { teamId: selectedCloudWorkItem.teamId })
      .then((detail) => {
        if (cancelled) return;
        setCloudWorkItemDetail(detail);
        setCloudError(null);
      })
      .catch((detailError) => {
        if (!cancelled) setCloudError(detailError instanceof Error ? detailError.message : String(detailError));
      })
      .finally(() => {
        if (!cancelled) setCloudLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, selectedCloudWorkItem]);

  const refreshSelectedCloudWorkItem = useCallback(
    async (workItem: CloudWorkItem) => {
      if (!connection) return;
      const detail = await api.cloudWorkItem(connection, workItem.id, { teamId: workItem.teamId });
      setCloudWorkItemDetail(detail);
      setCloudWorkItems((current) => {
        const withoutCurrent = current.filter((item) => item.id !== detail.workItem.id);
        return [detail.workItem, ...withoutCurrent].sort(
          (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
      });
    },
    [connection],
  );

  const openCloudHome = useCallback(() => {
    setSelectedCloudWorkItemId(null);
    setSelectedAppId(null);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    setCloudError(null);
    setView("cloud");
  }, [setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setView]);

  const selectCloudWorkItem = useCallback(
    (workItem: CloudWorkItem) => {
      setSelectedCloudWorkItemId(workItem.id);
      setSelectedAppId(null);
      setSelectedProjectId(projectSelectionKey("cloud", workItem.projectId));
      setSelectedSessionId(null);
      setCloudError(null);
      setView("cloud");
    },
    [setSelectedAppId, setSelectedProjectId, setSelectedSessionId, setView],
  );

  const createCloudWork = useCallback(
    async (input: { projectId: string; prompt: string }) => {
      if (!connection) {
        setCloudError("OpenPond App server is not connected.");
        return false;
      }
      const project = cloudProjectById.get(input.projectId);
      if (!project) {
        setCloudError("Select a Cloud Project before starting a task.");
        return false;
      }
      const title = input.prompt.split(/\s+/).slice(0, 12).join(" ").slice(0, 120) || "Cloud task";
      const parsed = parseComposerSlashCommandPrompt(input.prompt);
      const createPipelineRequest =
        parsed && (parsed.command === "create" || parsed.command === "edit")
          ? buildHostedCloudWorkCreatePipelineRequest({
              command: parsed.command,
              objective: parsed.args || input.prompt,
              payload: bootstrap,
              project,
              source: "cloud_work_home",
            })
          : null;
      if (parsed?.command === "edit" && !createPipelineRequest) {
        const message = "Select an agent-backed Cloud work item before using /edit.";
        setCloudError(message);
        setError(message);
        return false;
      }
      const createPipeline = createPipelineRequest
        ? buildInitialCreatePipelineSnapshot(createPipelineRequest)
        : null;
      const sourceRef =
        createPipelineRequest?.adapter.kind === "hosted"
          ? createPipelineRequest.adapter.sourceRef
          : project.defaultBranch ?? null;
      const baseSha =
        createPipelineRequest?.adapter.kind === "hosted"
          ? createPipelineRequest.adapter.baseSha
          : null;
      setCloudBusy(true);
      setCloudError(null);
      try {
        const detail = await api.createCloudWorkItem(connection, {
          teamId: project.teamId,
          projectId: project.id,
          title: createPipelineRequest?.objective ?? title,
          initialMessage: input.prompt,
          sourceRef,
          baseSha,
          createPipelineRequest,
          createPipeline,
        });
        setCloudWorkItemDetail(detail);
        setCloudWorkItems((current) => [detail.workItem, ...current.filter((item) => item.id !== detail.workItem.id)]);
        setSelectedCloudWorkItemId(detail.workItem.id);
        setSelectedAppId(null);
        setSelectedProjectId(projectSelectionKey("cloud", project.id));
        setSelectedSessionId(null);
        setView("cloud");
        if (createPipelineRequest) {
          showToast("Agent plan is ready for review.", "info");
          return true;
        }
        await api.handleCloudWorkItemInBackground(connection, detail.workItem.id, {
          teamId: project.teamId,
          prompt: input.prompt,
          sourceRef: project.defaultBranch ?? null,
          branchPolicy: { mode: "patch_only" },
          budget: { maxDurationSeconds: 1800 },
        });
        await refreshSelectedCloudWorkItem(detail.workItem);
        showToast("Cloud task started in the background.", "success");
        return true;
      } catch (workError) {
        const message = workError instanceof Error ? workError.message : String(workError);
        setCloudError(message);
        setError(message);
        return false;
      } finally {
        setCloudBusy(false);
      }
    },
    [
      bootstrap,
      cloudProjectById,
      connection,
      refreshSelectedCloudWorkItem,
      setError,
      setSelectedAppId,
      setSelectedProjectId,
      setSelectedSessionId,
      setView,
      showToast,
    ],
  );

  const sendCloudWorkItemMessage = useCallback(
    async (message: string) => {
      if (!connection || !selectedCloudWorkItem) return;
      const createPipelineRequest =
        cloudWorkItemDetail?.createPipelineRequest ??
        selectedCloudWorkItem.createPipelineRequest ??
        null;
      const currentCreatePipeline =
        cloudWorkItemDetail?.createPipeline ??
        selectedCloudWorkItem.createPipeline ??
        null;
      const revision = message.trim().match(/^revise plan:\s*([\s\S]+)$/i)?.[1]?.trim() ?? "";
      const revisedCreatePipeline =
        createPipelineRequest && revision
          ? reviseCreatePipelineSnapshot(
              currentCreatePipeline ?? buildInitialCreatePipelineSnapshot(createPipelineRequest),
              revision,
            )
          : currentCreatePipeline;
      setCloudBusy(true);
      setCloudError(null);
      try {
        const response = await api.sendCloudWorkItemMessage(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
          message,
          createPipelineRequest: revision ? createPipelineRequest : undefined,
          createPipeline: revision ? revisedCreatePipeline : undefined,
        });
        setCloudWorkItemDetail((current) =>
          current
            ? {
                ...current,
                createPipelineRequest: revision
                  ? createPipelineRequest
                  : current.createPipelineRequest,
                createPipeline: revision
                  ? revisedCreatePipeline
                  : current.createPipeline,
                workItem: revision
                  ? {
                      ...current.workItem,
                      createPipelineRequest,
                      createPipeline: revisedCreatePipeline,
                    }
                  : current.workItem,
                messages: [
                  ...current.messages,
                  response.userMessage,
                  response.message,
                ],
              }
            : current,
        );
      } catch (messageError) {
        const errorMessage = messageError instanceof Error ? messageError.message : String(messageError);
        setCloudError(errorMessage);
        setError(errorMessage);
      } finally {
        setCloudBusy(false);
      }
    },
    [cloudWorkItemDetail, connection, selectedCloudWorkItem, setError],
  );

  const handleCloudWorkItemBackground = useCallback(
    async (message: string | null) => {
      if (!connection || !selectedCloudWorkItem) return;
      const createPipelineRequest =
        cloudWorkItemDetail?.createPipelineRequest ??
        selectedCloudWorkItem.createPipelineRequest ??
        null;
      const currentCreatePipeline =
        cloudWorkItemDetail?.createPipeline ??
        selectedCloudWorkItem.createPipeline ??
        null;
      const approvedCreatePipeline = createPipelineRequest
        ? approveCreatePipelineSnapshot(
            currentCreatePipeline ?? buildInitialCreatePipelineSnapshot(createPipelineRequest),
          )
        : null;
      setCloudBusy(true);
      setCloudError(null);
      try {
        if (message) {
          await api.sendCloudWorkItemMessage(connection, selectedCloudWorkItem.id, {
            teamId: selectedCloudWorkItem.teamId,
            message,
          });
        }
        await api.handleCloudWorkItemInBackground(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
          prompt: message,
          sourceRef: selectedCloudWorkItem.sourceRef,
          baseSha: selectedCloudWorkItem.baseSha,
          branchPolicy: { mode: "patch_only" },
          budget: { maxDurationSeconds: 1800 },
          createPipelineRequest,
          createPipeline: approvedCreatePipeline,
          payload: createPipelineRequest
            ? { createPipelineDecision: "approved", createPipelineState: "applying_source" }
            : undefined,
        });
        await refreshSelectedCloudWorkItem(selectedCloudWorkItem);
        showToast(
          createPipelineRequest
            ? "Agent create pipeline started in the background."
            : "Cloud task started in the background.",
          "success",
        );
      } catch (backgroundError) {
        const messageText = backgroundError instanceof Error ? backgroundError.message : String(backgroundError);
        setCloudError(messageText);
        setError(messageText);
      } finally {
        setCloudBusy(false);
      }
    },
    [cloudWorkItemDetail, connection, refreshSelectedCloudWorkItem, selectedCloudWorkItem, setError, showToast],
  );

  const cancelCloudWorkItemTask = useCallback(
    async () => {
      if (!connection || !selectedCloudWorkItem) return;
      setCloudBusy(true);
      setCloudError(null);
      try {
        await api.cancelCloudWorkItemTask(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
        });
        await refreshSelectedCloudWorkItem(selectedCloudWorkItem);
        showToast("Cloud task stopped.", "success");
      } catch (cancelError) {
        const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
        setCloudError(message);
        setError(message);
      } finally {
        setCloudBusy(false);
      }
    },
    [connection, refreshSelectedCloudWorkItem, selectedCloudWorkItem, setError, showToast],
  );

  const cancelCloudWorkItemCreatePipeline = useCallback(
    async () => {
      if (!connection || !selectedCloudWorkItem) return;
      const createPipelineRequest =
        cloudWorkItemDetail?.createPipelineRequest ??
        selectedCloudWorkItem.createPipelineRequest ??
        null;
      if (!createPipelineRequest) {
        await cancelCloudWorkItemTask();
        return;
      }
      const currentCreatePipeline =
        cloudWorkItemDetail?.createPipeline ??
        selectedCloudWorkItem.createPipeline ??
        buildInitialCreatePipelineSnapshot(createPipelineRequest);
      const cancelledCreatePipeline = cancelCreatePipelineSnapshot(currentCreatePipeline);
      setCloudBusy(true);
      setCloudError(null);
      try {
        const response = await api.sendCloudWorkItemMessage(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
          message: "Cancel create plan",
          createPipelineRequest,
          createPipeline: cancelledCreatePipeline,
        });
        setCloudWorkItemDetail((current) =>
          current
            ? {
                ...current,
                createPipelineRequest,
                createPipeline: cancelledCreatePipeline,
                workItem: {
                  ...current.workItem,
                  createPipelineRequest,
                  createPipeline: cancelledCreatePipeline,
                },
                messages: [...current.messages, response.userMessage, response.message],
              }
            : current,
        );
        setCloudWorkItems((current) =>
          current.map((item) =>
            item.id === selectedCloudWorkItem.id
              ? {
                  ...item,
                  createPipelineRequest,
                  createPipeline: cancelledCreatePipeline,
                }
              : item,
          ),
        );
        showToast("Agent create plan cancelled.", "success");
      } catch (cancelError) {
        const message = cancelError instanceof Error ? cancelError.message : String(cancelError);
        setCloudError(message);
        setError(message);
      } finally {
        setCloudBusy(false);
      }
    },
    [
      cancelCloudWorkItemTask,
      cloudWorkItemDetail,
      connection,
      selectedCloudWorkItem,
      setError,
      showToast,
    ],
  );

  return {
    cloudBusy,
    cloudError,
    cloudLoading,
    cloudWorkItemDetail,
    cloudWorkItems,
    selectedCloudWorkItem,
    selectedCloudWorkItemId,
    cancelCloudWorkItemCreatePipeline,
    cancelCloudWorkItemTask,
    createCloudWork,
    handleCloudWorkItemBackground,
    openCloudHome,
    selectCloudWorkItem,
    sendCloudWorkItemMessage,
    setCloudError,
    setSelectedCloudWorkItemId,
  };
}
