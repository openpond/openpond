import type { PonderLocalMessagePresentation } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";

export type PonderLinkedLocalWork = {
  operationId: string;
  installationId: string;
  profileId: string;
  ownerUserId: string;
  teamId: string;
  sessionId: string | null;
  title: string;
  status: string;
  error: string | null;
  deliveries: Array<{
    inputId: string;
    localTurnId: string;
    ponderTurnId: string | null;
    status: "claimed" | "acknowledged" | "attention";
    outcome?: "completed" | "failed" | "cancelled";
    attentionAt: string | null;
    attentionReason: string | null;
    outputs: PonderLocalMessagePresentation["outputs"];
  }>;
};
export async function assertOriginalPonderDesktop(
  connection: ClientConnection,
  source: Pick<PonderLinkedLocalWork, "installationId" | "profileId" | "ownerUserId" | "teamId">,
) {
  const { ownerScope } = await apiFetch<{ ownerScope: typeof source | null }>(
    connection,
    "/v1/ponder/desktop",
  );
  if (
    !ownerScope ||
    (["installationId", "profileId", "ownerUserId", "teamId"] as const).some(
      (key) => ownerScope[key] !== source[key],
    )
  ) {
    throw new Error("Open this task on its original desktop, account and workspace.");
  }
}
