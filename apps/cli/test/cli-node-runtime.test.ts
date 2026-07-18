import { describe, expect, test } from "vitest";

import { openPondTuiNodeRuntimeMessage } from "../src/cli/node-runtime";

describe("OpenPond TUI Node runtime messaging", () => {
  test("accepts supported Node 24 runtimes", () => {
    expect(openPondTuiNodeRuntimeMessage("24.18.0")).toBeNull();
    expect(openPondTuiNodeRuntimeMessage("24.99.1")).toBeNull();
  });

  test("explains how to recover from an incompatible runtime", () => {
    const message = openPondTuiNodeRuntimeMessage("20.10.0");

    expect(message).toContain("requires Node.js 24.18.0");
    expect(message).toContain("detected Node.js 20.10.0");
    expect(message).toContain("nvm install 24.18.0 && nvm use 24.18.0");
  });

  test("rejects newer major lines until they are validated", () => {
    expect(openPondTuiNodeRuntimeMessage("25.1.0")).toContain(
      "Node 24 release line",
    );
  });
});
