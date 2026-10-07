import type { RuntimeEvent } from "@openpond/contracts";

const MAX_PENDING_WRITES = 8;

/** Ordered durable writes. Producers wait for capacity instead of flooding the
 * remote storage transport; the first failure prevents a successful final flush. */
export function createRuntimeEventWriteQueue(
  persist: (event: RuntimeEvent) => Promise<void>,
) {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let requests = 0;
  let failure: unknown;
  let failed = false;
  const capacityWaiters = new Set<() => void>();
  const idleWaiters = new Set<() => void>();

  function assertHealthy(): void {
    if (failed) throw failure;
  }

  async function waitForCapacity(): Promise<void> {
    assertHealthy();
    while (pending >= MAX_PENDING_WRITES) {
      await new Promise<void>((resolve) => capacityWaiters.add(resolve));
      assertHealthy();
    }
  }

  async function append(event: RuntimeEvent): Promise<void> {
    requests += 1;
    try {
      await waitForCapacity();
      // Capacity may have been claimed by an earlier continuation.
      while (pending >= MAX_PENDING_WRITES) await waitForCapacity();
      pending += 1;
      const write = tail.then(() => {
        assertHealthy();
        return persist(event);
      });
      tail = write.catch((error: unknown) => {
        if (!failed) { failed = true; failure = error; }
      });
      try {
        await write;
      } finally {
        pending -= 1;
        for (const resolve of capacityWaiters) resolve();
        capacityWaiters.clear();
      }
    } finally {
      requests -= 1;
      if (requests === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  }

  async function drain(): Promise<void> {
    while (requests > 0) {
      await new Promise<void>((resolve) => idleWaiters.add(resolve));
    }
    assertHealthy();
  }

  return { append, drain, assertHealthy, waitForCapacity };
}
