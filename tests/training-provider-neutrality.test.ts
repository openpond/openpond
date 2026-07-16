import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { tasksetFixture, planFixture } from "./helpers/training-fixtures";

describe("training provider neutrality", () => {
  test("keeps canonical Tasksets and Plans free of provider payloads", async () => {
    const canonical = JSON.stringify({ taskset: tasksetFixture(), plan: planFixture() }).toLowerCase();
    for (const forbidden of ["prime_hosted", "fireworks", "runpod", "openpond managed", "tinker", "providerpayload"]) expect(canonical).not.toContain(forbidden);
    const creator = (await readFile("apps/server/src/training/task-creator.ts", "utf8")).toLowerCase();
    expect(creator).not.toContain("fireworks");
    expect(creator).not.toContain("prime_hosted");
  });
});
