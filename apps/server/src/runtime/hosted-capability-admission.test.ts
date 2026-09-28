import { describe, expect, it } from "vitest";
import type { HostStorageCapability } from "@openpond/agent-runtime";

import { assertHostedWorkCapabilities, HOSTED_WORK_REQUIRED_OPERATIONS } from "./hosted-capability-admission.js";
import { hostedBoundedPage } from "../store/hosted-bounded-page.js";

const complete: HostStorageCapability = {
  contractVersion: 1,
  operations: [...HOSTED_WORK_REQUIRED_OPERATIONS],
  allowedTools: [],
  maxPageSize: 200,
  maxRequestBytes: 256_000,
  maxInFlight: 32,
};

describe("hosted private storage admission", () => {
  it("rejects missing write authority and smaller transport bounds before a turn starts", () => {
    expect(() => assertHostedWorkCapabilities(complete)).not.toThrow();
    for (const operation of ["session/put", "turn/put", "event/append", "approval/upsert", "usage/upsert"] as const) {
      expect(() => assertHostedWorkCapabilities({ ...complete,
        operations: complete.operations.filter((entry) => entry !== operation) })).toThrow("capabilities are incomplete");
    }
    expect(() => assertHostedWorkCapabilities({ ...complete, maxRequestBytes: 255_999 })).toThrow("limits are incompatible");
    expect(() => assertHostedWorkCapabilities({ ...complete, maxInFlight: 31 })).toThrow("limits are incompatible");
    expect(() => assertHostedWorkCapabilities({ ...complete, maxPageSize: 199 })).toThrow("limits are incompatible");
  });

  it("reduces only an oversized history page and keeps the last one-row failure visible", async () => {
    const attempted: number[] = [];
    const result = await hostedBoundedPage(200, async (limit) => {
      attempted.push(limit);
      if (limit > 25) throw new Error("Host storage request failed: host_storage_response_too_large");
      return { limit };
    });
    expect(attempted).toEqual([200, 100, 50, 25]);
    expect(result).toEqual({ limit: 25 });
    await expect(hostedBoundedPage(2, async () => {
      throw new Error("Host storage response is too large.");
    })).rejects.toThrow("Host storage response is too large.");
    await expect(hostedBoundedPage(200, async () => {
      throw new Error("host_storage_lease_lost");
    })).rejects.toThrow("host_storage_lease_lost");
  });
});
