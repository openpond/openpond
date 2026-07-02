import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";
import { isCliEntrypoint } from "../apps/server/dist/utils.js";

describe("server utils", () => {
  test("detects CLI entrypoint when the file URL contains encoded spaces", () => {
    const originalArgv = process.argv;
    const entryPath = path.resolve("/tmp/openpond nightly.app/Contents/Resources/server/index.js");
    process.argv = [originalArgv[0] ?? "node", entryPath];
    try {
      assert.equal(isCliEntrypoint(pathToFileURL(entryPath).href), true);
    } finally {
      process.argv = originalArgv;
    }
  });
});
