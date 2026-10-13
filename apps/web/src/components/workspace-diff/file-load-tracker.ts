/** A completed read updates its own tab; a closed or superseded read never
 * opens a tab. An unseen completion can open normally (React may batch the
 * loading and completed requests before the sidebar first mounts). */
export class FileLoadTracker {
  private pending = new Map<string, number>();
  private cancelled = new Set<number>();

  receive(path: string, request?: { loadId?: number; loading?: boolean }): "open" | "complete" | "ignore" {
    const id = request?.loadId;
    if (id === undefined) return "open";
    const pending = this.pending.get(path);
    if (request?.loading) {
      if (pending !== undefined && pending !== id) this.cancelled.add(pending);
      this.pending.set(path, id);
      return "open";
    }
    if (this.cancelled.delete(id) || (pending !== undefined && pending !== id)) return "ignore";
    this.pending.delete(path);
    return pending === undefined ? "open" : "complete";
  }

  close(path: string) {
    const id = this.pending.get(path);
    if (id !== undefined) this.cancelled.add(id);
    this.pending.delete(path);
  }

  retain(paths: Set<string>) {
    for (const path of this.pending.keys()) if (!paths.has(path)) this.close(path);
  }
}
