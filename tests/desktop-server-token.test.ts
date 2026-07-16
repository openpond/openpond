import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDesktopServerToken } from "../apps/desktop/src/desktop-server-token";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Desktop server token resolution", () => {
  test("prefers the supervisor-injected token over a stale channel token file", async () => {
    const tokenFile = await createTokenFile("stale-nightly-token");

    await expect(readDesktopServerToken({
      environmentToken: " current-supervisor-token ",
      tokenFile,
    })).resolves.toBe("current-supervisor-token");
  });

  test("falls back to the private token file when no token is injected", async () => {
    const tokenFile = await createTokenFile(" file-token ");

    await expect(readDesktopServerToken({ tokenFile })).resolves.toBe("file-token");
  });

  test("returns null when neither source contains a token", async () => {
    await expect(readDesktopServerToken({
      environmentToken: "   ",
      tokenFile: path.join(os.tmpdir(), "missing-openpond-desktop-token"),
    })).resolves.toBeNull();
  });
});

async function createTokenFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-desktop-token-"));
  temporaryDirectories.push(directory);
  const tokenFile = path.join(directory, "token");
  await writeFile(tokenFile, contents, { mode: 0o600 });
  return tokenFile;
}
