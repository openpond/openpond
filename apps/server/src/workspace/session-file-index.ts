import { promises as fs } from "node:fs";
import type { RuntimeEvent, Session, SessionFileArtifact } from "@openpond/contracts";
import path from "node:path";
import { workspaceFileVersion } from "./workspace-file-version.js";
import { sessionFileArtifacts } from "./session-file-artifacts.js";

/** Refresh disk metadata independently of transcript parsing. Opening the New
 * tab must not replay the entire conversation on every file-list refresh. */
export function createSessionFileIndex(deps: {
  getSession: (id: string) => Promise<Session>;
  latestSequence: (id: string) => Promise<number>;
  events: (id: string) => Promise<RuntimeEvent[]>;
}) {
  const cache = new Map<string, { key: string; files: Promise<SessionFileArtifact[]> }>();
  return async (sessionId: string) => {
    const [session, sequence] = await Promise.all([deps.getSession(sessionId), deps.latestSequence(sessionId)]);
    const key = JSON.stringify([sequence, session.updatedAt, session.cwd, session.workspaceId]);
    let entry = cache.get(sessionId);
    if (!entry || entry.key !== key) {
      const files = deps.events(sessionId).then(events => sessionFileArtifacts(session, events));
      entry = { key, files };
      cache.set(sessionId, entry);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      void files.catch(() => { if (cache.get(sessionId)?.files === files) cache.delete(sessionId); });
    }
    return { files: await recentSessionFiles(await entry.files) };
  };
}

export async function recentSessionFiles(files: SessionFileArtifact[]): Promise<SessionFileArtifact[]> {
  const updated: SessionFileArtifact[] = [];
  // Limit simultaneous filesystem requests even in conversations with many
  // outputs. Missing files keep their durable original reference.
  for (let offset = 0; offset < files.length; offset += 16) {
    updated.push(...await Promise.all(files.slice(offset, offset + 16).map(async file => {
      if (file.sandboxId) return file;
      try {
        const stat = await fs.lstat(file.path, { bigint: true });
        if (!stat.isFile()) return file;
        return { ...file, sizeBytes: Number(stat.size), updatedAt: new Date(Number(stat.mtimeMs)).toISOString(),
          revision: (await workspaceFileVersion(path.dirname(file.path), file.path, true)).revision ?? file.revision };
      } catch { return file; }
    })));
  }
  return updated.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
}
