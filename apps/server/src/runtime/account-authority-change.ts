export type AccountAuthorityChange = <T>(mutation: () => Promise<T>) => Promise<T>;

/** Keep reconnects fenced until a complete account/workspace mutation is saved. */
export function createAccountAuthorityChange(input: {
  before(): Promise<void>;
  after(): void;
}): AccountAuthorityChange {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(mutation: () => Promise<T>) => {
    const operation = queue.then(async () => {
      try {
        await input.before();
        return await mutation();
      } finally {
        input.after();
      }
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
}
