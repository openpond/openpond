import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Make Agent affordance", () => {
  test("keeps the button visible at the narrow composer breakpoint", () => {
    const css = readFileSync(
      new URL("../apps/web/src/styles/chat/composer-footer.css", import.meta.url),
      "utf8",
    );
    const narrowRule = css.match(/@container \(max-width: 620px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(narrowRule).not.toContain(".composer-create-control");
    expect(narrowRule).toContain(".context-status-shell");
  });
});
