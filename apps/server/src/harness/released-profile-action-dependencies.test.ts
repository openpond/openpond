import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { prepareReleasedProfileActionDependencies } from "./released-profile-action-dependencies.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function runPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-profile-action-deps-"));
  directories.push(directory);
  return directory;
}

test("released Agent dependencies require one lock and install without lifecycle scripts", async () => {
  const directory = await runPath();
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", dependencies: { "is-number": "^7.0.0" } }));
  const install = vi.fn().mockResolvedValue(undefined);
  await expect(prepareReleasedProfileActionDependencies({ runPath: directory, install })).rejects.toThrow("requires exactly one");
  await fs.writeFile(path.join(directory, "package-lock.json"), "{}\n");
  await prepareReleasedProfileActionDependencies({ runPath: directory, install });
  expect(install).toHaveBeenCalledWith("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  expect((await fs.lstat(path.join(directory, "node_modules", "openpond-agent-sdk"))).isSymbolicLink()).toBe(true);
  await fs.writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await expect(prepareReleasedProfileActionDependencies({ runPath: directory, install })).rejects.toThrow("requires exactly one");
});

test("released Agent dependencies reject local paths before installation", async () => {
  const directory = await runPath();
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: { "other-package": "file:../../mutable" } }));
  await fs.writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const install = vi.fn();
  await expect(prepareReleasedProfileActionDependencies({ runPath: directory, install })).rejects.toThrow("portable registry version");
  expect(install).not.toHaveBeenCalled();
});
