/** Process-local notification only; durable state must be re-read after subscribing. */
export class TaskSignals {
  #listeners = new Map<string, Set<() => void>>();

  notify(taskId: string): void {
    for (const listener of [...(this.#listeners.get(taskId) ?? [])]) listener();
  }

  subscribe(taskId: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(taskId);
    if (!listeners) this.#listeners.set(taskId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(taskId);
    };
  }

  /** Subscribe before reading the condition to close the arrival-before-wait race. */
  async wait<T>(input: {
    taskIds: readonly string[];
    read: () => Promise<T | null>;
    deadline: number;
    signal: AbortSignal;
  }): Promise<T | null> {
    let wake = () => {};
    let revision = 0;
    const changed = () => { revision += 1; wake(); };
    const unsubscribers = [...new Set(input.taskIds)].map((id) => this.subscribe(id, changed));
    const timer = setTimeout(changed, Math.max(0, input.deadline - Date.now()));
    input.signal.addEventListener("abort", changed);
    try {
      while (true) {
        input.signal.throwIfAborted();
        const before = revision;
        const result = await input.read();
        if (result !== null) return result;
        if (Date.now() >= input.deadline) return null;
        if (revision !== before) continue;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (revision !== before || input.signal.aborted) resolve();
        });
      }
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", changed);
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
  }
}

/** Serializes admission/finalization, not the lifetime of a task or a wait. */
export class TaskSerialExecutor {
  #tails = new Map<string, Promise<void>>();

  async run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(taskId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => {}, () => {});
    this.#tails.set(taskId, tail);
    try { return await result; }
    finally { if (this.#tails.get(taskId) === tail) this.#tails.delete(taskId); }
  }
}
