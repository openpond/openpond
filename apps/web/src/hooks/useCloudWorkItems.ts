import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type {
  BootstrapPayload,
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  LocalProject,
  UsageRequestAttribution,
  WorkspaceState,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { ShowAppToast } from "../app/app-state";
import { projectSelectionKey, type AppView } from "../lib/app-models";
import { parseComposerSlashCommandPrompt, type ParsedComposerSlashCommand } from "../lib/composer-slash-commands";
import {
  approveCreateImproveRun,
  buildHostedCloudWorkCreateImproveRun,
  buildInitialCreateImproveRun,
  cancelCreateImproveRun,
  reviseCreateImproveRun,
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
  rememberWorkspaceState: (state: WorkspaceState) => void;
  showToast: ShowAppToast;
};

type CloudWorkItemBackgroundTarget = {
  sourceRuntimeId?: string;
  sourceSandboxId?: string;
  agentId?: string;
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
  rememberWorkspaceState,
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
  const selectedCloudWorkItemLocalProject = useMemo<LocalProject | null>(() => {
    if (!selectedCloudWorkItem) return null;
    return (
      bootstrap?.localProjects.find((project) => {
        const linked = project.linkedSandboxProject;
        return (
          linked?.teamId === selectedCloudWorkItem.teamId &&
          linked.projectId === selectedCloudWorkItem.projectId
        );
      }) ?? null
    );
  }, [bootstrap?.localProjects, selectedCloudWorkItem]);

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
    async (input: {
      projectId: string;
      prompt: string;
      select?: boolean;
      localProjectId?: string | null;
      localProjectName?: string | null;
      localWorkspacePath?: string | null;
      sourceRef?: string | null;
      baseSha?: string | null;
      requestedExecutionTarget?: "queue_cloud" | "cloud_workspace" | "cloud_home" | null;
    }) => {
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
      const proposedCreateImproveRun =
        parsed && (parsed.command === "create" || parsed.command === "edit")
          ? buildHostedCloudWorkCreateImproveRun({
              command: parsed.command,
              objective: parsed.args || input.prompt,
              payload: bootstrap,
              project,
              source: "cloud_work_home",
            })
          : null;
      if (parsed?.command === "edit" && !proposedCreateImproveRun) {
        const message = "Select an agent-backed Cloud work item before using /edit.";
        setCloudError(message);
        setError(message);
        return false;
      }
      const createImproveRun = proposedCreateImproveRun
        ? buildInitialCreateImproveRun(proposedCreateImproveRun)
        : null;
      const usageAttribution = cloudSlashUsageAttribution(parsed);
      const sourceRef =
        createImproveRun?.adapter.kind === "hosted"
          ? createImproveRun.adapter.sourceRef
          : input.sourceRef ?? project.defaultBranch ?? null;
      const baseSha =
        createImproveRun?.adapter.kind === "hosted"
          ? createImproveRun.adapter.baseSha
          : input.baseSha ?? null;
      const shouldSelectWorkItem = input.select ?? true;
      setCloudBusy(true);
      setCloudError(null);
      try {
        const detail = await api.createCloudWorkItem(connection, {
          teamId: project.teamId,
          projectId: project.id,
          title: createImproveRun?.objective ?? title,
          initialMessage: input.prompt,
          sourceRef,
          baseSha,
          localProjectId: input.localProjectId ?? null,
          localProjectName: input.localProjectName ?? null,
          localWorkspacePath: input.localWorkspacePath ?? null,
          requestedExecutionTarget: input.requestedExecutionTarget ?? null,
          createImproveRun,
          usageAttribution,
        });
        setCloudWorkItemDetail(detail);
        setCloudWorkItems((current) => [detail.workItem, ...current.filter((item) => item.id !== detail.workItem.id)]);
        if (shouldSelectWorkItem) {
          setSelectedCloudWorkItemId(detail.workItem.id);
          setSelectedAppId(null);
          setSelectedProjectId(projectSelectionKey("cloud", project.id));
          setSelectedSessionId(null);
          setView("cloud");
        }
        if (createImproveRun) {
          showToast("Agent plan is ready for review.", "info");
          return true;
        }
        await api.handleCloudWorkItemInBackground(connection, detail.workItem.id, {
          teamId: project.teamId,
          prompt: input.prompt,
          sourceRef,
          baseSha,
          branchPolicy: { mode: "patch_only" },
          budget: { maxDurationSeconds: 1800 },
          usageAttribution,
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
      const currentCreateImproveRun =
        cloudWorkItemDetail?.createImproveRun ??
        selectedCloudWorkItem.createImproveRun ??
        null;
      const revision = message.trim().match(/^revise plan:\s*([\s\S]+)$/i)?.[1]?.trim() ?? "";
      const revisedCreateImproveRun =
        currentCreateImproveRun && revision
          ? reviseCreateImproveRun(currentCreateImproveRun, revision)
          : currentCreateImproveRun;
      setCloudBusy(true);
      setCloudError(null);
      try {
        const response = await api.sendCloudWorkItemMessage(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
          message,
          createImproveRun: revision ? revisedCreateImproveRun : undefined,
          usageAttribution: revision ? createImproveUsageAttribution(currentCreateImproveRun) : undefined,
        });
        setCloudWorkItemDetail((current) =>
          current
            ? {
                ...current,
                createImproveRun: revision
                  ? revisedCreateImproveRun
                  : current.createImproveRun,
                workItem: revision
                  ? {
                      ...current.workItem,
                      createImproveRun: revisedCreateImproveRun,
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
      const currentCreateImproveRun =
        cloudWorkItemDetail?.createImproveRun ??
        selectedCloudWorkItem.createImproveRun ??
        null;
      const approvedCreateImproveRun = currentCreateImproveRun
        ? approveCreateImproveRun(currentCreateImproveRun)
        : null;
      const usageAttribution = createImproveUsageAttribution(currentCreateImproveRun);
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
          ...cloudWorkItemBackgroundTarget(selectedCloudWorkItem, cloudWorkItemDetail),
          branchPolicy: { mode: "patch_only" },
          budget: { maxDurationSeconds: 1800 },
          createImproveRun: approvedCreateImproveRun,
          usageAttribution,
          payload: currentCreateImproveRun
            ? { createImproveDecision: "approved", createImproveState: "applying_source" }
            : undefined,
        });
        await refreshSelectedCloudWorkItem(selectedCloudWorkItem);
        showToast(
          currentCreateImproveRun
            ? "Agent Create/Improve run started in the background."
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

  const applyCloudWorkItemPatchLocally = useCallback(async () => {
    if (!connection || !selectedCloudWorkItem) return;
    const workItem = cloudWorkItemDetail?.workItem ?? selectedCloudWorkItem;
    if (!selectedCloudWorkItemLocalProject) {
      const message = "No linked local checkout exists for this Cloud Project.";
      setCloudError(message);
      setError(message);
      return;
    }
    const sandboxId = workItem.latestSandboxId ?? null;
    if (!sandboxId) {
      const message = "No reviewed Cloud sandbox is available for this work item.";
      setCloudError(message);
      setError(message);
      return;
    }
    const confirmed = window.confirm(
      `Apply the reviewed Cloud patch to ${selectedCloudWorkItemLocalProject.name}? Your local checkout must be clean.`,
    );
    if (!confirmed) return;
    setCloudBusy(true);
    setCloudError(null);
    try {
      const response = await api.applyCloudWorkItemLocalPatch(connection, workItem.id, {
        teamId: workItem.teamId,
        localProjectId: selectedCloudWorkItemLocalProject.id,
        sandboxId,
      });
      rememberWorkspaceState(response.workspaceState);
      setCloudWorkItems((current) =>
        current.map((item) => (item.id === response.workItem.id ? response.workItem : item)),
      );
      setCloudWorkItemDetail((current) =>
        current
          ? {
              ...current,
              workItem: response.workItem,
            }
          : current,
      );
      showToast(
        `Applied Cloud patch to ${response.localProject.name} (${response.patch.fileCount} file${
          response.patch.fileCount === 1 ? "" : "s"
        }).`,
        "success",
      );
    } catch (applyError) {
      const message = applyError instanceof Error ? applyError.message : String(applyError);
      setCloudError(message);
      setError(message);
    } finally {
      setCloudBusy(false);
    }
  }, [
    cloudWorkItemDetail,
    connection,
    rememberWorkspaceState,
    selectedCloudWorkItem,
    selectedCloudWorkItemLocalProject,
    setError,
    showToast,
  ]);

  const cancelCloudWorkItemCreatePipeline = useCallback(
    async () => {
      if (!connection || !selectedCloudWorkItem) return;
      const currentCreateImproveRun =
        cloudWorkItemDetail?.createImproveRun ??
        selectedCloudWorkItem.createImproveRun ??
        null;
      if (!currentCreateImproveRun) {
        await cancelCloudWorkItemTask();
        return;
      }
      const cancelledCreateImproveRun = cancelCreateImproveRun(currentCreateImproveRun);
      setCloudBusy(true);
      setCloudError(null);
      try {
        const response = await api.sendCloudWorkItemMessage(connection, selectedCloudWorkItem.id, {
          teamId: selectedCloudWorkItem.teamId,
          message: "Cancel create plan",
          createImproveRun: cancelledCreateImproveRun,
          usageAttribution: createImproveUsageAttribution(currentCreateImproveRun),
        });
        setCloudWorkItemDetail((current) =>
          current
            ? {
                ...current,
                createImproveRun: cancelledCreateImproveRun,
                workItem: {
                  ...current.workItem,
                  createImproveRun: cancelledCreateImproveRun,
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
                  createImproveRun: cancelledCreateImproveRun,
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
    selectedCloudWorkItemLocalProject,
    applyCloudWorkItemPatchLocally,
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

function cloudSlashUsageAttribution(
  command: ParsedComposerSlashCommand | null,
): UsageRequestAttribution | undefined {
  return command
    ? {
        surface: "chat",
        workflowKind: "slash_command",
        commandName: `/${command.command}`,
        commandSource: "prompt_parse",
      }
    : undefined;
}

function createImproveUsageAttribution(
  run: CloudWorkItem["createImproveRun"],
): UsageRequestAttribution | undefined {
  if (!run?.command) return undefined;
  return {
    surface: "create_improve",
    workflowKind: "planner",
    createImproveRunId: run.id,
    commandName: run.command,
    commandSource: "api",
  };
}

export function cloudWorkItemBackgroundTarget(
  workItem: CloudWorkItem,
  detail: CloudWorkItemDetail | null,
): CloudWorkItemBackgroundTarget {
  const detailApplies = detail?.workItem.id === workItem.id;
  const detailWorkItem = detailApplies ? detail.workItem : null;
  const runtimeSession = detailApplies
    ? (
        detail.runtimeSessions.find((session) => !session.endedAt && (session.runtimeId || session.sandboxId)) ??
        detail.runtimeSessions.find((session) => session.runtimeId || session.sandboxId) ??
        null
      )
    : null;
  const sourceRuntimeId =
    detailWorkItem?.latestRuntimeId ??
    workItem.latestRuntimeId ??
    runtimeSession?.runtimeId ??
    null;
  const sourceSandboxId =
    detailWorkItem?.latestSandboxId ??
    workItem.latestSandboxId ??
    runtimeSession?.sandboxId ??
    null;
  const agentId =
    detailWorkItem?.assignedAgentId ??
    workItem.assignedAgentId ??
    null;
  return {
    ...(sourceRuntimeId ? { sourceRuntimeId } : {}),
    ...(sourceSandboxId ? { sourceSandboxId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}
