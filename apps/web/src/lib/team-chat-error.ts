const TEAM_CHAT_ERROR_MESSAGES: Record<string, string> = {
  team_chat_team_not_found: "You no longer have access to this workspace.",
  workspace_membership_required: "You no longer have access to this workspace.",
  team_chat_billing_inactive:
    "Workspace chat is unavailable while its subscription is inactive. Ask the workspace owner to review billing.",
  workspace_billing_suspended: "Workspace billing is suspended. Ask the workspace owner to update billing.",
  workspace_billing_cancelled: "This workspace subscription is cancelled. Ask the workspace owner to reactivate it.",
  workspace_checkout_pending: "Workspace checkout is still pending. Ask the workspace owner to finish setup.",
  member_paid_usage_disabled: "The workspace owner has not enabled paid model usage for your account.",
  member_spend_cap_exceeded: "You reached your workspace member spending limit. Ask the workspace owner to adjust it.",
  member_opchat_quota_exceeded: "You reached your workspace member OpChat limit. Ask the workspace owner to adjust it.",
  member_search_quota_exceeded: "You reached your workspace member Search limit. Ask the workspace owner to adjust it.",
  workspace_prepaid_credit_required:
    "This workspace needs more prepaid credits. Ask the workspace owner to add credits.",
  workspace_spend_cap_exceeded: "This workspace reached its spend cap. Ask the workspace owner to review billing.",
  opchat_workspace_quota_exceeded: "This workspace reached its included OpChat limit for the period.",
  search_workspace_quota_exceeded: "This workspace reached its included Search limit for the period.",
};

export function teamChatErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.trim().toLowerCase();
  for (const [code, message] of Object.entries(TEAM_CHAT_ERROR_MESSAGES)) {
    if (normalized.includes(code)) return message;
  }
  if (normalized.includes("event stream ended")) {
    return "Team chat realtime disconnected. Messages will continue to refresh automatically.";
  }
  return raw;
}
