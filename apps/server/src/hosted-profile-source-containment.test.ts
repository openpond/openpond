import path from "node:path";

import { expect, test } from "vitest";

import { isHostedProfileSourceWithinRepo } from "./hosted-profile-source-containment.js";

test("a hosted Profile can use the repo root without admitting a sibling or parent", () => {
  const repo = path.resolve("/tmp/hosted-profile-source");
  expect(isHostedProfileSourceWithinRepo(repo, repo)).toBe(true);
  expect(isHostedProfileSourceWithinRepo(repo, path.join(repo, "profiles", "default"))).toBe(true);
  expect(isHostedProfileSourceWithinRepo(repo, `${repo}-other`)).toBe(false);
  expect(isHostedProfileSourceWithinRepo(repo, path.dirname(repo))).toBe(false);
});
