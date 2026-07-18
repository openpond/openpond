import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";

describe("App hook order", () => {
  test("declares the right-sidebar callback before the startup early return", async () => {
    const source = (
      await Promise.all([
        readFile(
          new URL(
            "../apps/web/src/app/useAppSecondaryRuntime.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../apps/web/src/app/AppRuntimeView.tsx", import.meta.url),
          "utf8",
        ),
      ])
    ).join("\n");
    const callbackIndex = source.indexOf("const toggleRightSidebar = useCallback");
    const startupReturnIndex = source.indexOf("if (!startup.ready)");

    expect(callbackIndex).toBeGreaterThan(-1);
    expect(startupReturnIndex).toBeGreaterThan(-1);
    expect(callbackIndex).toBeLessThan(startupReturnIndex);
  });
});
