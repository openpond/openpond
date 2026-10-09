import type { RuntimeEvent } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { createBrowserControlQueue } from "../openpond/browser-control-queue.js";
import { createHtmlVisualService } from "./visual-service.js";

/** Recover publications before advertising the desktop tools to a new turn. */
export async function createDesktopVisualRuntime(input: {
  home: string;
  store: Pick<SqliteStore, "getSession" | "runtimeEventsForSession">;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  const browserControlQueue = createBrowserControlQueue();
  const htmlVisuals = createHtmlVisualService({
    home: input.home,
    executor: browserControlQueue.executor,
    getSession: id => input.store.getSession(id),
    events: id => input.store.runtimeEventsForSession(id),
    append: input.appendRuntimeEvent,
  });
  await htmlVisuals.recover();
  return {
    browserControlQueue,
    htmlVisuals,
    http: {
      htmlVisuals,
      browserControlActive: browserControlQueue.isActive,
      browserControlRegister: browserControlQueue.registerDesktopExecutor,
      browserControlNext: browserControlQueue.claimNext,
      browserControlComplete: browserControlQueue.completeRequest,
      browserControlStatus: browserControlQueue.status,
    },
  };
}
