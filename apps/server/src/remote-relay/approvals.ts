import type { Approval } from "@openpond/contracts";

/** Only binary, per-request decisions are exposed; question forms stay local. */
export function remoteApprovalSupported(approval: Approval) {
  if (approval.kind === "command" || approval.kind === "file_change") return true;
  if (approval.kind !== "permissions") return false;
  try {
    const detail = JSON.parse(approval.detail) as { questions?: unknown; options?: { kind?: string }[] };
    return !detail.questions && Array.isArray(detail.options) && detail.options.some(option => option.kind === "allow_once")
      && detail.options.some(option => option.kind === "reject_once");
  } catch { return false; }
}
