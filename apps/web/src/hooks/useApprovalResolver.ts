import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ResolveApprovalRequest } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";

export function useApprovalResolver({
  connection,
  setError,
}: {
  connection: ClientConnection | null;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  return useCallback(
    async (approvalId: string, decision: ResolveApprovalRequest["decision"]): Promise<void> => {
      if (!connection) {
        const error = new Error("OpenPond App server is not connected.");
        setError(error.message);
        throw error;
      }
      setError(null);
      try {
        await api.resolveApproval(connection, approvalId, { decision });
      } catch (approvalError) {
        const message =
          approvalError instanceof Error ? approvalError.message : String(approvalError);
        setError(message);
        throw approvalError;
      }
    },
    [connection, setError],
  );
}
