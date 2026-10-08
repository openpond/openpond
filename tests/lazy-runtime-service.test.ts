import { expect, test } from "vitest";
import { lazyRuntimeService } from "../apps/server/src/runtime/lazy-runtime-service.js";

// Shutdown must neither start unused services nor leak a service whose first
// import is still pending. An admitted running call must be cancelled and drained.
test("owns deferred initialization and drains service work at shutdown", async () => {
  let unusedLoads = 0;
  const unused = lazyRuntimeService(async () => { unusedLoads++; return { async close() { } }; });
  await unused.close();
  expect(unusedLoads).toBe(0);

  const imported = Promise.withResolvers<void>();
  let loads = 0, disposals = 0, executions = 0;
  const deferred = lazyRuntimeService(async () => {
    loads++;
    await imported.promise;
    return { async execute() { executions++; }, async close() { disposals++; } };
  });
  const methods = deferred.methods(["execute"]);
  const first = expect(methods.execute()).rejects.toThrow("closing");
  const second = expect(methods.execute()).rejects.toThrow("closing");
  const closed = deferred.close();
  expect(deferred.close()).toBe(closed);
  imported.resolve();
  await Promise.all([first, second, closed]);
  expect({ loads, disposals, executions }).toEqual({ loads: 1, disposals: 1, executions: 0 });

  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  let settled = false;
  const active = lazyRuntimeService(async () => ({
    async execute() { started.resolve(); await cancelled.promise; settled = true; },
    async close() { cancelled.resolve(); },
  }));
  const running = active.use(service => service.execute());
  await started.promise;
  await active.close();
  expect(settled).toBe(true);
  await running;
  await expect(active.use(service => service.execute())).rejects.toThrow("closing");
});
