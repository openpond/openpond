export type ServerLifecycleEntry = {
  id: string;
  phase: number;
  close(): void | Promise<void>;
};

export class ServerLifecycleRegistry {
  readonly #entries = new Map<string, ServerLifecycleEntry>();
  #closePromise: Promise<void> | null = null;
  #closed = new Set<string>();

  register(entry: ServerLifecycleEntry): void {
    if (this.#closePromise) throw new Error("Cannot register a lifecycle entry after shutdown starts.");
    if (this.#entries.has(entry.id)) throw new Error(`Duplicate server lifecycle entry: ${entry.id}`);
    this.#entries.set(entry.id, entry);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#closeAll();
    return this.#closePromise;
  }

  status(): { registered: string[]; closed: string[] } {
    return { registered: [...this.#entries.keys()], closed: [...this.#closed] };
  }

  async #closeAll(): Promise<void> {
    const failures: Array<{ id: string; error: unknown }> = [];
    const phases = [...new Set([...this.#entries.values()].map((entry) => entry.phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const entries = [...this.#entries.values()].filter((entry) => entry.phase === phase);
      const results = await Promise.allSettled(entries.map((entry) => Promise.resolve().then(() => entry.close())));
      results.forEach((result, index) => {
        const entry = entries[index]!;
        this.#closed.add(entry.id);
        if (result.status === "rejected") failures.push({ id: entry.id, error: result.reason });
      });
    }
    if (this.#closed.size !== this.#entries.size) {
      failures.push({ id: "registry", error: new Error("Not every lifecycle entry was closed.") });
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `Server shutdown failed for: ${failures.map((failure) => failure.id).join(", ")}`,
      );
    }
  }
}
