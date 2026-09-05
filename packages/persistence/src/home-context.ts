import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

const homes = new AsyncLocalStorage<string>();
export const currentOpenPondHome = (): string | undefined => homes.getStore();
export function withOpenPondHome<T>(home: string, operation: () => T): T { return homes.run(path.resolve(home), operation); }
export function bindHomeCallbacks<T extends object>(home: string, callbacks: T): T {
  return Object.fromEntries(Object.entries(callbacks).map(([name, value]) => [name, typeof value === "function"
    ? (...args: unknown[]) => withOpenPondHome(home, () => value(...args))
    : value])) as T;
}
