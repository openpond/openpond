import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createPrimeComputeProviderSetup } from "../apps/server/src/compute/prime-provider-setup.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("Prime compute provider setup", () => {
  test("encrypts the credential, performs read-only checks, and exposes only aggregate status", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-prime-setup-"));
    try {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const request = vi.fn(async (input: string | URL | Request, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/availability/gpus?")) {
          return json({
            items: [
              offering("available-1", 1.35),
              offering("variable-1", 0.8, { isVariable: true }),
              { ...offering("unavailable-1", 1.1), stockStatus: "Unavailable" },
            ],
          });
        }
        if (url.includes("/ssh_keys/")) {
          return json({ data: [{ id: "ssh-1" }], total_count: 1 });
        }
        return json({ detail: "not found" }, 404);
      });
      const secretPaths = {
        secretsFilePath: path.join(storeDir, "provider-secrets.json"),
        keyFilePath: path.join(storeDir, "provider-secrets.key"),
      };
      const setup = createPrimeComputeProviderSetup({
        storeDir,
        secretPaths,
        request: request as typeof fetch,
        now: () => new Date(NOW),
      });
      const apiKey = "prime_secret_that_must_never_escape";

      expect((await setup.status()).state).toBe("disconnected");
      expect((await setup.saveCredential({ apiKey })).state).toBe("configured");
      expect(await setup.resolveCredential()).toBe(apiKey);

      const validated = await setup.validateCredential();
      expect(validated).toMatchObject({
        state: "credential_valid",
        credential: {
          configured: true,
          redacted: "••••••••••••",
          storedLocally: true,
        },
        availability: {
          availableOfferingCount: 1,
          lowestHourlyUsd: 1.35,
          registeredSshKeyCount: 1,
        },
        worker: {
          ready: false,
          status: "setup_required",
        },
        lastError: null,
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) =>
        (call.init.headers as Record<string, string>).authorization
        === `Bearer ${apiKey}`)).toBe(true);
      expect(calls.every((call) => call.init.method === undefined)).toBe(true);

      const persisted = [
        await readFile(secretPaths.secretsFilePath, "utf8"),
        await readFile(secretPaths.keyFilePath, "utf8"),
        await readFile(
          path.join(storeDir, "compute", "prime-provider-validation.json"),
          "utf8",
        ),
      ].join("\n");
      expect(persisted).not.toContain(apiKey);
      expect(JSON.stringify(validated)).not.toContain(apiKey);

      const deleted = await setup.deleteCredential();
      expect(deleted.state).toBe("disconnected");
      expect(deleted.credential.configured).toBe(false);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("records a bounded, redacted validation error without rejecting the settings flow", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-prime-setup-error-"));
    try {
      const apiKey = "prime_secret_that_must_be_redacted";
      const setup = createPrimeComputeProviderSetup({
        storeDir,
        secretPaths: {
          secretsFilePath: path.join(storeDir, "provider-secrets.json"),
          keyFilePath: path.join(storeDir, "provider-secrets.key"),
        },
        request: vi.fn(async () =>
          new Response(`invalid credential ${apiKey}`, { status: 401 })) as typeof fetch,
        now: () => new Date(NOW),
      });
      await setup.saveCredential({ apiKey });

      const status = await setup.validateCredential();

      expect(status.state).toBe("error");
      expect(status.lastError).toContain("401");
      expect(status.lastError).toContain("[redacted]");
      expect(status.lastError).not.toContain(apiKey);
      expect(JSON.stringify(status)).not.toContain(apiKey);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("resolves the credential only at launch time and fails closed when disconnected", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-prime-resolve-"));
    try {
      const setup = createPrimeComputeProviderSetup({
        storeDir,
        secretPaths: {
          secretsFilePath: path.join(storeDir, "provider-secrets.json"),
          keyFilePath: path.join(storeDir, "provider-secrets.key"),
        },
      });
      await expect(setup.resolveCredential()).rejects.toThrow(
        "before launching Prime compute",
      );
      await setup.saveCredential({ apiKey: "launch-only-secret" });
      expect(await setup.resolveCredential()).toBe("launch-only-secret");
      await setup.deleteCredential();
      await expect(setup.resolveCredential()).rejects.toThrow(
        "before launching Prime compute",
      );
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

function offering(
  cloudId: string,
  hourlyUsd: number,
  prices: { isVariable?: boolean } = {},
) {
  return {
    cloudId,
    gpuType: "H100_80GB",
    gpuCount: 1,
    security: "secure_cloud",
    stockStatus: "Available",
    prices: {
      onDemand: hourlyUsd,
      isVariable: prices.isVariable ?? false,
    },
    prepaidTime: null,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
