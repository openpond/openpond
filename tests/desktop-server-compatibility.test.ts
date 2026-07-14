import { describe, expect, test } from "bun:test";

import {
  bundledServerLaunchPort,
  isCompatibleDesktopServer,
  localServerPort,
  parseListeningProcessIds,
  stopStaleLocalDesktopServer,
} from "../apps/desktop/src/desktop-server-compatibility";

describe("desktop server compatibility", () => {
  test("only reuses the OpenPond server bundled for the same Desktop version", () => {
    expect(
      isCompatibleDesktopServer(
        { ok: true, server: "openpond-app-server", version: "0.0.21" },
        "0.0.21",
      ),
    ).toBe(true);
    expect(
      isCompatibleDesktopServer(
        { ok: true, server: "openpond-app-server", version: "0.0.15" },
        "0.0.21",
      ),
    ).toBe(false);
    expect(isCompatibleDesktopServer({ ok: true, version: "0.0.21" }, "0.0.21")).toBe(false);
    expect(isCompatibleDesktopServer(null, "0.0.21")).toBe(false);
  });

  test("only considers explicit loopback ports eligible for stale-server retirement", () => {
    expect(localServerPort("http://127.0.0.1:17874")).toBe(17874);
    expect(localServerPort("http://localhost:17875/")).toBe(17875);
    expect(localServerPort("https://api.openpond.ai:17874")).toBeNull();
    expect(localServerPort("not a url")).toBeNull();
  });

  test("parses and de-duplicates listener process ids", () => {
    expect(parseListeningProcessIds("49803\n49803\r\n 58327\ninvalid\n")).toEqual([
      49803,
      58327,
    ]);
  });

  test("uses an ephemeral port when an incompatible listener cannot be retired", () => {
    const existing = { ok: true, server: "openpond-app-server", version: "0.0.15" };

    expect(bundledServerLaunchPort(17_874, existing, false)).toBe(0);
    expect(bundledServerLaunchPort(17_874, existing, true)).toBe(0);
    expect(bundledServerLaunchPort(17_874, null, false)).toBe(0);
    expect(bundledServerLaunchPort(17_874, null, true)).toBe(17_874);
  });

  test("retires only the stale listener and excludes the current desktop process", async () => {
    const terminated: number[] = [];
    const result = await stopStaleLocalDesktopServer("http://127.0.0.1:17874", {
      platform: "darwin",
      currentPid: 20,
      findProcessIds: async (port) => {
        expect(port).toBe(17_874);
        return [10, 20];
      },
      terminateProcess: async (pid) => {
        terminated.push(pid);
      },
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ stopped: true, processIds: [10] });
    expect(terminated).toEqual([10]);
  });
});
