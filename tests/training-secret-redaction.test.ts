import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanAndRedactEvidence } from "../apps/server/src/training/privacy";
import { listTrainingDestinationSecretRefs, readTrainingDestinationSecret, writeTrainingDestinationSecret } from "../apps/server/src/training/destination-secrets";

describe("training privacy and credentials", () => {
  test("redacts secrets/PII and encrypts destination credentials outside bundles", async () => {
    const scan = scanAndRedactEvidence("Email me at expert@example.com with api_key=super-secret-value");
    expect(scan).toMatchObject({ secretStatus: "blocked", piiStatus: "review" });
    expect(scan.redacted).not.toContain("super-secret-value");
    expect(scan.redacted).not.toContain("expert@example.com");
    const directory = await mkdtemp(path.join(os.tmpdir(), "training-secrets-"));
    try {
      await writeTrainingDestinationSecret({ directory, destinationId: "custom", value: "credential-value", timestamp: "2026-07-12T00:00:00Z" });
      expect(await readTrainingDestinationSecret({ directory, destinationId: "custom" })).toBe("credential-value");
      expect(await listTrainingDestinationSecretRefs(directory)).toEqual([expect.objectContaining({ destinationId: "custom", configured: true })]);
      expect(await readFile(path.join(directory, "training-destinations.json"), "utf8")).not.toContain("credential-value");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
