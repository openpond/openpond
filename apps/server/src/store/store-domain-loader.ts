import { AsyncLocalStorage } from "node:async_hooks";

/** Admit before importing so shutdown also waits for a domain's first call. */
export class StoreDomainLifecycle {
  private closing = false;
  private readonly admission = new AsyncLocalStorage<{ active: boolean }>();
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    // Repository authority may read another domain while an admitted transaction
    // is draining. Its descendants keep that admission until the operation settles.
    const inherited = this.admission.getStore();
    if (this.closing && !inherited?.active) return Promise.reject(new Error("SQLite store is closing"));
    const admission = { active: true };
    const pending = Promise.resolve().then(() => this.admission.run(admission, operation))
      .finally(() => { admission.active = false; });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  async close(): Promise<void> {
    this.closing = true;
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

type AsyncMethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

export function lazyStoreDomain<T extends object>(lifecycle: StoreDomainLifecycle, load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  const get = () => pending ??= load();
  const call = <R>(invoke: (store: T) => Promise<R>) => lifecycle.run(async () => invoke(await get()));
  return {
    call,
    methods<const K extends AsyncMethodKeys<T>>(
      keys: readonly K[],
      ...missing: Exclude<AsyncMethodKeys<T>, K> extends never ? [] : ["Missing domain methods", Exclude<AsyncMethodKeys<T>, K>]
    ): Pick<T, K> {
      // Each listed member is constrained to an async method. The mapped facade
      // preserves its original arguments/return type; apply preserves its owner.
      void missing;
      return Object.fromEntries(keys.map(key => [key, (...args: unknown[]) => call(store => {
        const method = store[key] as (...values: unknown[]) => Promise<unknown>;
        return method.apply(store, args);
      })])) as Pick<T, K>;
    },
  };
}
