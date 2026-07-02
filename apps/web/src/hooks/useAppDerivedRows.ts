import { useMemo } from "react";
import type { ChatProvider, ContextUsageSnapshot } from "@openpond/contracts";
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
  contextUsage,
  pinnedItems,
  pinnedPreviewKeys,
  pinnedProjects,
  projectRows,
  visibleLocalProjectRows,
}: {
  activeProvider: ChatProvider;
  contextUsage: ContextUsageSnapshot | null;
  pinnedItems: PinnedSidebarItem[];
  pinnedPreviewKeys: string[];
  pinnedProjects: SidebarProjectItem[];
  projectRows: SidebarProjectItem[];
  visibleLocalProjectRows: SidebarProjectItem[];
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
      }),
    [activeProvider, contextUsage],
  );
  const sidebarWorkspaceAppIds = useMemo(
    () =>
      Array.from(
        new Set(
          [...pinnedProjects, ...visibleLocalProjectRows]
            .filter(isLocalSidebarProjectItem)
            .map((item) => item.project.id),
        ),
      ),
    [pinnedProjects, visibleLocalProjectRows],
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
