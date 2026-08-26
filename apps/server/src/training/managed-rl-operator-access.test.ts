import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { managedRlOperatorAccess } from "./managed-rl-operator-access.js";

describe("managed RL operator access", () => {
  test("is absent unless the complete override is configured", async () => {
    await expect(managedRlOperatorAccess({})).resolves.toBeNull();
    await expect(managedRlOperatorAccess({
      OPENPOND_MANAGED_RL_API_URL: "https://staging-api.example.test",
    })).rejects.toThrow("must be configured together");
  });

  test("loads one private team-bound credential without exposing it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-managed-access-"));
    const credentialFile = path.join(directory, "credential.json");
    await writeFile(credentialFile, JSON.stringify({ apiKey: "opk_private", teamId: "team_staging" }));
    await chmod(credentialFile, 0o600);

    await expect(managedRlOperatorAccess({
      OPENPOND_MANAGED_RL_API_URL: "https://staging-api.example.test",
      OPENPOND_MANAGED_RL_CREDENTIAL_FILE: credentialFile,
      OPENPOND_MANAGED_RL_TEAM_ID: "team_staging",
    })).resolves.toEqual({
      apiBaseUrl: "https://staging-api.example.test",
      token: "opk_private",
      teamId: "team_staging",
    });
  });

  test("rejects public or cross-team credential files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-managed-access-"));
    const credentialFile = path.join(directory, "credential.json");
    await writeFile(credentialFile, JSON.stringify({ apiKey: "opk_private", teamId: "team_other" }));
    await chmod(credentialFile, 0o644);

    await expect(managedRlOperatorAccess({
      OPENPOND_MANAGED_RL_API_URL: "https://staging-api.example.test",
      OPENPOND_MANAGED_RL_CREDENTIAL_FILE: credentialFile,
      OPENPOND_MANAGED_RL_TEAM_ID: "team_staging",
    })).rejects.toThrow("private regular file");
  });
});
