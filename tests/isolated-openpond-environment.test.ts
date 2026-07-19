import path from "node:path";
import { describe, expect, test } from "vitest";

import { defaultLocalProfileRepoPath } from "../packages/cloud/src/profile/local-profile";
import { isolatedOpenPondEnvironment } from "../scripts/isolated-openpond-environment";

describe("isolatedOpenPondEnvironment", () => {
  test("keeps Profile config inside the isolated app home", () => {
    const appHome = path.join(path.sep, "tmp", "openpond-harness");

    expect(isolatedOpenPondEnvironment(appHome)).toEqual({
      OPENPOND_APP_HOME: appHome,
      OPENPOND_CONFIG_DIR: path.join(appHome, "config"),
    });
  });

  test("places the default Profile repo under the isolated config directory", () => {
    const previousConfigDir = process.env.OPENPOND_CONFIG_DIR;
    const configDir = path.join(path.sep, "tmp", "openpond-harness", "config");
    process.env.OPENPOND_CONFIG_DIR = configDir;

    try {
      expect(defaultLocalProfileRepoPath()).toBe(
        path.join(configDir, "profiles", "default-repo"),
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.OPENPOND_CONFIG_DIR;
      else process.env.OPENPOND_CONFIG_DIR = previousConfigDir;
    }
  });
});
