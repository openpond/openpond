import { useCallback, useEffect, useState } from "react";

export function useSidebarExpansion({
  selectedProjectId,
}: {
  selectedProjectId: string | null;
}) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());

  const expandProject = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const toggleProjectExpanded = useCallback((projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedProjectId) expandProject(selectedProjectId);
  }, [expandProject, selectedProjectId]);

  return {
    expandedProjectIds,
    expandProject,
    toggleProjectExpanded,
    setExpandedProjectIds,
  };
}
