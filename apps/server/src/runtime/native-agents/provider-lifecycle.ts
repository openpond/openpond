const clients = new Map<string, Set<() => Promise<void>>>();
const changing = new Set<string>();

export function registerNativeProviderClient(
  provider: string,
  close: () => Promise<void>,
): () => void {
  if (changing.has(provider))
    throw new Error("The provider account is changing. Reconnect after setup finishes.");
  const owned = clients.get(provider) ?? new Set();
  owned.add(close);
  clients.set(provider, owned);
  return () => {
    owned.delete(close);
    if (!owned.size) clients.delete(provider);
  };
}

export async function changeNativeProvider<T>(
  provider: string,
  mutation: () => Promise<T>,
): Promise<T> {
  if (changing.has(provider)) throw new Error("The provider is already being changed.");
  changing.add(provider);
  try {
    await Promise.all([...(clients.get(provider) ?? [])].map((close) => close()));
    return await mutation();
  } finally {
    changing.delete(provider);
  }
}
