import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDiffSummary } from "@openpond/contracts";

import { api, type ClientConnection } from "../api";

export type LabCandidateReviewSelection = {
  runId: string;
  candidateId: string;
  title: string;
  fileRootPath: string | null;
  initialPath: string | null;
};

export function useLabCandidateReview(connection: ClientConnection | null) {
  const [selection, setSelection] = useState<LabCandidateReviewSelection | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openFileRequest, setOpenFileRequest] = useState<{ id: number; path: string } | null>(null);
  const selectionRef = useRef<LabCandidateReviewSelection | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (
    target: LabCandidateReviewSelection,
    options: { silent?: boolean } = {},
  ) => {
    if (!connection) {
      setDiff(null);
      setError("OpenPond App server is not connected.");
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!options.silent) setLoading(true);
    setError(null);
    try {
      const next = await api.getCreateImproveCandidateDiff(
        connection,
        target.runId,
        target.candidateId,
      );
      const current = selectionRef.current;
      if (
        requestId !== requestIdRef.current ||
        current?.runId !== target.runId ||
        current.candidateId !== target.candidateId
      ) {
        return;
      }
      setDiff(next);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === requestIdRef.current && !options.silent) setLoading(false);
    }
  }, [connection]);

  const activate = useCallback((target: LabCandidateReviewSelection | null) => {
    const currentSelection = selectionRef.current;
    if (
      target &&
      currentSelection?.runId === target.runId &&
      currentSelection.candidateId === target.candidateId
    ) {
      return;
    }
    selectionRef.current = target;
    setSelection(target);
    setOpenFileRequest(null);
    if (!target) {
      requestIdRef.current += 1;
      setDiff(null);
      setError(null);
      setLoading(false);
      return;
    }
    setDiff((current) => {
      if (current?.appId === candidateWorkspaceId(target)) return current;
      return null;
    });
    void load(target);
  }, [load]);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    const target = selectionRef.current;
    if (!target) return;
    await load(target, options);
  }, [load]);

  const openFile = useCallback((path: string) => {
    setOpenFileRequest({ id: Date.now(), path });
  }, []);

  useEffect(() => {
    if (connection) return;
    activate(null);
  }, [activate, connection]);

  return {
    selection,
    diff,
    loading,
    error,
    openFileRequest,
    activate,
    refresh,
    openFile,
  };
}

function candidateWorkspaceId(selection: LabCandidateReviewSelection): string {
  return `candidate:${selection.runId}:${selection.candidateId}`;
}
