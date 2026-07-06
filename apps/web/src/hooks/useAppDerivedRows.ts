import { useMemo } from "react";
import type {
  ChatProvider,
  ContextCompactionPreferences,
  ContextUsageSnapshot,
} from "@openpond/contracts";
import {
  contextWindowStatusFromUsage,
  type ContextWindowStatus,
} from "../lib/context-window";
import {
  isLocalSidebarProjectItem,
  orderPinnedItemsByKeys,
  type PinnedSidebarItem,
  type SidebarProjectItem,
} from "../lib/app-models";

export function useAppDerivedRows({
  activeProvider,
  contextCompaction,
  contextUsage,
  pinnedItems,
  pinnedPreviewKeys,
  pinnedProjects,
  projectRows,
  visibleProjectRows,
}: {
  activeProvider: ChatProvider;
  contextCompaction: ContextCompactionPreferences;
  contextUsage: ContextUsageSnapshot | null;
  pinnedItems: PinnedSidebarItem[];
  pinnedPreviewKeys: string[];
  pinnedProjects: SidebarProjectItem[];
  projectRows: SidebarProjectItem[];
  visibleProjectRows: SidebarProjectItem[];
}) {
  const pinnedRows = useMemo(
    () => orderPinnedItemsByKeys(pinnedItems, pinnedPreviewKeys),
    [pinnedItems, pinnedPreviewKeys],
  );
  const contextWindowStatus: ContextWindowStatus = useMemo(
    () =>
      contextWindowStatusFromUsage({
        provider: activeProvider,
        snapshot: contextUsage,
        preferences: contextCompaction,
      }),
    [activeProvider, contextCompaction, contextUsage],
  );
  const sidebarWorkspaceAppIds = useMemo(
    () =>
      Array.from(
        new Set(
          [...pinnedProjects, ...visibleProjectRows]
            .filter(isLocalSidebarProjectItem)
            .map((item) => item.project.id),
        ),
      ),
    [pinnedProjects, visibleProjectRows],
  );
  const commandProjectRows = useMemo(
    () => [...pinnedProjects, ...projectRows],
    [pinnedProjects, projectRows],
  );

  return {
    commandProjectRows,
    contextWindowStatus,
    pinnedRows,
    sidebarWorkspaceAppIds,
  };
}
