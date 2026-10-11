/** Forked Codex rollouts retain their own header followed by ancestor headers.
 * Only the declared, contiguous ancestry is metadata for that source. */
export class CodexMetadataChain {
  metadata: Record<string, unknown> | null = null;
  private parentId: string | null = null;
  private closed = false;
  private readonly ids = new Set<string>();

  accept(row: Record<string, unknown>): boolean {
    if (row.type !== "session_meta") { this.closed = true; return true; }
    const payload = row.payload;
    if (this.closed || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const value = payload as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id || value.id.length > 500
      || this.ids.has(value.id) || this.ids.size >= 16) return false;
    if (this.metadata) {
      if (value.id !== this.parentId) return false;
      for (const key of ["creator_user_id", "creator_account_id"])
        if (this.metadata[key] != null && value[key] != null && this.metadata[key] !== value[key]) return false;
    } else this.metadata = value;
    this.ids.add(value.id);
    this.parentId = typeof value.forked_from_id === "string" ? value.forked_from_id : null;
    return true;
  }
}
