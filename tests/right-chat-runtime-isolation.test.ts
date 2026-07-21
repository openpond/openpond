import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("right chat runtime isolation", () => {
  test("keeps panel provider and model changes out of the global new-chat defaults", async () => {
    const hook = await readFile("apps/web/src/hooks/useRightChatPanels.ts", "utf8");
    const secondary = await readFile("apps/web/src/app/useAppSecondaryRuntime.ts", "utf8");

    expect(hook).not.toContain("setDraftProvider");
    expect(hook).not.toContain("setDraftModel");
    expect(secondary).not.toMatch(/useRightChatPanels\(\{[\s\S]*?setDraftProvider/);
    expect(secondary).not.toMatch(/useRightChatPanels\(\{[\s\S]*?setDraftModel/);
    expect(hook).toContain("provider: panel.provider");
    expect(hook).toContain("model: panel.model");
  });
});
