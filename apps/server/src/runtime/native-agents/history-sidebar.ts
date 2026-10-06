import { SessionSchema, type Session } from "@openpond/contracts";
import type { NativeSession, NativeSource } from "@openpond/evals/native-conversations";
import type { SqliteStore } from "../../store/store.js";
import type { NativeAgentId } from "./config.js";

export function matchingNativeHistorySession(shells: readonly Session[], input: {
  id: string; source: NativeSource; session: NativeSession; provider: NativeAgentId; instanceId: string;
}): Session | undefined {
  return shells.find((shell) => !shell.metadata?.nativeBranch && (
    shell.metadata?.nativeHistoryId === input.id || shell.id === `native-${input.id}` ||
    (shell.nativeAgent?.provider === input.provider && shell.nativeAgent.instanceId === input.instanceId &&
      shell.nativeAgent.sessionId === input.session.nativeSessionId && shell.nativeAgent.cwd === input.session.cwd &&
      (!shell.metadata?.sourceInstanceId || shell.metadata.sourceInstanceId === input.source.instanceId))
  ));
}

/** Metadata-only discovery. Importing a row never launches an agent or qualifies continuation. */
export async function retainNativeSidebarShell(store: SqliteStore, shells: Session[], input: {
  id: string; source: NativeSource; session: NativeSession; provider: NativeAgentId; instanceId: string;
}): Promise<{ session: Session; changed: boolean }> {
  const existing = matchingNativeHistorySession(shells, input);
  if (existing) {
    const sameSource = existing.metadata?.sourceInstanceId === input.source.instanceId;
    const sourceChanged = sameSource && existing.metadata?.sidebarActivityAt !== input.session.updatedAt &&
      Date.parse(input.session.updatedAt) > Date.parse(String(existing.metadata?.sidebarActivityAt ?? existing.createdAt));
    const needsIdentity = existing.metadata?.nativeHistoryId !== input.id;
    const titleChanged = existing.metadata?.nativeSourceTitle !== input.session.title;
    if (!sourceChanged && !needsIdentity && !titleChanged) return { session: existing, changed: false };
    const updated = await store.updateSession(existing.id, (current) => ({ ...current,
      title: current.title === current.metadata?.nativeSourceTitle ? input.session.title : current.title,
      metadata: { ...current.metadata, nativeHistoryId: input.id,
        sourceInstanceId: input.source.instanceId, sourceMachineId: input.source.machineId,
        nativeSource: input.source.source, nativeSourceTitle: input.session.title,
        ...(sourceChanged ? { sidebarActivityAt: input.session.updatedAt } : {}) },
    }));
    return { session: updated ?? existing, changed: Boolean(updated) };
  }
  const session = SessionSchema.parse({ id: `native-${input.id}`, experience: "work", provider: input.provider,
    title: input.session.title, appId: null, appName: null, cwd: input.session.cwd, codexThreadId: null,
    nativeAgent: null, createdAt: input.session.updatedAt, updatedAt: input.session.updatedAt,
    status: "idle", pinned: false, archived: false, order: 0,
    metadata: { nativeHistoryId: input.id, nativeHistoryProjection: true, nativeHistoryLoaded: false,
      nativeResumeAvailable: false, nativeReadOnlyReason: "Opening conversation…",
      sourceMachineId: input.source.machineId, sourceInstanceId: input.source.instanceId, nativeSource: input.source.source,
      nativeSourceTitle: input.session.title, sidebarActivityAt: input.session.updatedAt },
  });
  await store.insertSessionAtFront(session);
  shells.push(session);
  return { session, changed: true };
}
