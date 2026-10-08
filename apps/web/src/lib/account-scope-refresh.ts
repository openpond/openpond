// Scope changes can arrive while a previous account snapshot is still loading.
// Discard that snapshot and read again before publishing any account or team state.
export function createAccountScopeRefresh<T>(options: {
  fetch: () => Promise<T>;
  apply: (value: T) => void;
  onError: (error: unknown) => void;
}) {
  let revision = 0;
  let pending = false;
  let disposed = false;
  let running: Promise<void> | null = null;

  async function drain() {
    while (pending && !disposed) {
      pending = false;
      const requestedRevision = revision;
      try {
        const value = await options.fetch();
        if (!disposed && requestedRevision === revision) options.apply(value);
      } catch (error) {
        if (!disposed && requestedRevision === revision) options.onError(error);
      }
    }
  }

  return {
    refresh() {
      if (disposed) return Promise.resolve();
      revision += 1;
      pending = true;
      running ??= drain().finally(() => { running = null; });
      return running;
    },
    invalidate() {
      revision += 1;
      if (running) pending = true;
    },
    dispose() {
      disposed = true;
      revision += 1;
      pending = false;
    },
  };
}

export type AccountScopeRefresh = ReturnType<typeof createAccountScopeRefresh>;
