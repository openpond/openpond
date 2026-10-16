import type { ChatProvider, CodexReasoningEffort, ProviderSettings } from "@openpond/contracts";

/** Apply the destination catalog's effort contract at the transport boundary.
 * A saved effort belongs to the user; a model switch may make it unsupported. */
export function managedModelReasoningEffort(input:{provider:ChatProvider;model:string|null|undefined;selected:CodexReasoningEffort|null|undefined;settings:ProviderSettings|null|undefined}):CodexReasoningEffort|undefined {
  const capabilities=input.settings?.modelCaches[input.provider]?.models.find(model=>model.id===input.model)?.capabilities;
  if(!capabilities)return input.selected ?? undefined;
  const allowed=capabilities.reasoningEfforts;
  if(!capabilities.reasoning)return allowed.includes("off") ? "off" : undefined;
  if(!input.selected || !allowed.length)return input.selected ?? undefined;
  if(input.selected && allowed.includes(input.selected))return input.selected;
  return allowed.includes("high") ? "high" : allowed[0];
}
