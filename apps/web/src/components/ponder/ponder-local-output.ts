import type { PonderLocalMessagePresentation } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { assertOriginalPonderDesktop } from "./ponder-local-work";

export type PonderLocalOutputSource = Pick<
  PonderLocalMessagePresentation,
  | "operationId"
  | "turnId"
  | "installationId"
  | "profileId"
  | "ownerUserId"
  | "teamId"
>;

export async function downloadPonderLocalOutput(
  connection: ClientConnection,
  source: PonderLocalOutputSource,
  outputId: string,
  stillCurrent: () => boolean,
) {
  if (!source.turnId)
    throw new Error("This local result has no completed task turn.");
  await assertOriginalPonderDesktop(connection, source);
  if (!stillCurrent()) return;
  const result = await apiFetch<{
    filename: string;
    contentType: string;
    contentsBase64: string;
  }>(connection, "/v1/ponder/desktop/outputs", {
    method: "POST",
    body: JSON.stringify({
      operationId: source.operationId,
      turnId: source.turnId,
      outputId,
    }),
  });
  if (!stillCurrent()) return;
  const bytes = Uint8Array.from(atob(result.contentsBase64), (character) =>
    character.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: result.contentType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
