export function localPonderError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const messages: Record<string, string> = {
    local_ponder_model_unavailable: "Choose a configured model that supports Ponder’s coordination tools.",
    local_ponder_model_change_requires_idle: "Wait for Ponder to finish before changing its model.",
    local_ponder_setup_pending: "Finish setup with the previously selected model to recover this conversation.",
    local_ponder_configuration_changed: "Ponder settings changed. Reopen settings and try again.",
    local_ponder_control_changed: "This agent’s control changed. Review its current state and try again.",
    local_ponder_agent_not_found: "This agent is no longer available. Refresh Ponder’s agents.",
  };
  return messages[message] ?? message;
}
