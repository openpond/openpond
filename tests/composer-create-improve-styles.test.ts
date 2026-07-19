import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

describe("Create and Improve composer controls", () => {
  test("styles direct status actions in every interaction state", async () => {
    const styles = await readFile(
      "apps/web/src/styles/chat/composer.css",
      "utf8"
    );

    expect(styles).toContain(".composer-create-status-body > button {");
    expect(styles).toContain(
      ".composer-create-status-body > button:hover:not(:disabled)"
    );
    expect(styles).toContain(
      ".composer-create-status-body > button:focus-visible"
    );
    expect(styles).toContain(".composer-create-status-body > button:disabled");
  });
});
