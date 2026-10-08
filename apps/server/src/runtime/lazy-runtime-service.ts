type AsyncKeys<T> = { [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never }[keyof T];

/** One optional service owner. Unused services are never initialized at shutdown. */
export function lazyRuntimeService<T extends { close(): Promise<void>; }>(initialize: () => Promise<T>) {
  let initialization: Promise<T> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();

  function use<R>(operation: (service: T) => Promise<R>): Promise<R> {
    if (closing) return Promise.reject(new Error("Runtime service is closing"));
    initialization ??= Promise.resolve().then(initialize);
    const result = initialization.then(service => {
      // Closing may have begun while the implementation was being imported.
      if (closing) throw new Error("Runtime service is closing");
      return operation(service);
    });
    active.add(result);
    void result.then(() => active.delete(result), () => active.delete(result));
    return result;
  }

  return {
    use,
    methods<const K extends AsyncKeys<T>>(keys: readonly K[]): Pick<T, K> {
      return Object.fromEntries(keys.map(key => [key, (...args: unknown[]) => use(service => {
        const method = service[key] as (...values: unknown[]) => Promise<unknown>;
        return method.apply(service, args);
      })])) as Pick<T, K>;
    },
    close(): Promise<void> {
      return closing ??= Promise.resolve().then(async () => {
        try {
          // A failed initializer has no service to dispose; active callers retain
          // the original error. Successful initialization always has one owner.
          const service = await initialization?.catch(() => undefined);
          await service?.close();
        } finally {
          await Promise.allSettled([...active]);
        }
      });
    },
  };
}
