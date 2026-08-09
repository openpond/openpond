import { describe, expect, it } from "vitest";

import { executableSearchPath } from "./executable-search-path.js";

describe("executableSearchPath", () => {
  it("prioritizes user and operating-system tools over inherited host-runtime paths", () => {
    expect(
      executableSearchPath(
        {
          HOME: "/home/alex",
          PATH: "/embedded/runtime/bin:/usr/bin:/custom/bin",
        },
        "linux",
      ).split(":"),
    ).toEqual([
      "/home/alex/.local/bin",
      "/home/alex/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/embedded/runtime/bin",
      "/custom/bin",
    ]);
  });

  it("preserves the inherited Windows path", () => {
    expect(executableSearchPath({ PATH: "C:\\tools;C:\\Windows" }, "win32")).toBe(
      "C:\\tools;C:\\Windows",
    );
  });
});
