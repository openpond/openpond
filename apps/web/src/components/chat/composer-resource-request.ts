import { TaskResourceContextsSchema, type TaskResourceContext } from "@openpond/contracts";
import type { ResourceSetupDraft } from "../../lib/resource-setup-prompt";

export const COMPOSER_RESOURCE_REQUEST = "openpond-composer-resource-request";
export type ComposerResourceRequest = {
  sessionId: string | null;
  text: string;
  contexts: TaskResourceContext[];
  resourceSetup?: ResourceSetupDraft;
};
export function addResourceRequestToChat(request: ComposerResourceRequest) {
  window.dispatchEvent(
    new CustomEvent(COMPOSER_RESOURCE_REQUEST, {
      detail: { ...request, contexts: TaskResourceContextsSchema.parse(request.contexts) },
    }),
  );
}
