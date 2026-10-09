import { describe, expect, test, vi } from "vitest";
import { DesktopUpdateController, DesktopUpdateError, type DesktopUpdateDriver } from "../apps/desktop/src/desktop-update-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<DesktopUpdateDriver> = {}) {
  const driver: DesktopUpdateDriver = {
    check: vi.fn(async () => "0.3.0"), download: vi.fn(async () => {}),
    prepareInstall: vi.fn(async () => {}), install: vi.fn(), dispose: vi.fn(), ...overrides,
  };
  const shutdown = vi.fn(async () => {});
  const confirmRestart = vi.fn(async () => true);
  const recoverAfterShutdown = vi.fn(async () => {});
  const controller = new DesktopUpdateController({
    driver, shutdown, confirmRestart, recoverAfterShutdown,
    installedVersion: "0.2.47", channel: "stable", installKind: "appimage",
    publish: vi.fn(), logError: vi.fn(),
  });
  return { controller, driver, shutdown, confirmRestart, recoverAfterShutdown };
}

describe("desktop update lifecycle boundary", () => {
  // An initial network failure must recover on the next scheduled check;
  // repeated starts/manual clicks must share that check and stop must cancel it.
  test("checks on startup and every thirty minutes without overlap or checks after shutdown", async () => {
    vi.useFakeTimers();
    const retry = deferred<string | null>();
    const check = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockImplementation(() => retry.promise);
    const { controller, driver } = fixture({ check });
    try {
      controller.start();
      await controller.check();
      expect(controller.getState()).toMatchObject({ status: "error", retry: "check" });
      controller.start();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
      expect(check).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(check).toHaveBeenCalledTimes(2);
      const manualCheck = controller.check();
      expect(controller.check()).toBe(manualCheck);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(check).toHaveBeenCalledTimes(2);
      retry.resolve("0.3.0");
      await manualCheck;
      expect(controller.getState()).toMatchObject({ status: "available", version: "0.3.0" });
      controller.stop();
      controller.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(check).toHaveBeenCalledTimes(2);
      expect(driver.dispose).toHaveBeenCalledOnce();
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  // A double click or periodic check must not start a second download/install,
  // and 100% network progress must not grant restart before verification.
  test("serializes operations and drains the backend before one installation", async () => {
    const downloaded = deferred<void>();
    const drained = deferred<void>();
    const { controller, driver, shutdown } = fixture({
      download: vi.fn((progress) => { progress(100); return downloaded.promise; }),
    });
    shutdown.mockImplementation(() => drained.promise);
    await controller.check();
    const first = controller.download();
    expect(controller.download()).toBe(first);
    await Promise.resolve();
    expect(controller.getState()).toMatchObject({ status: "downloading", progress: 100 });
    expect(controller.check()).toBe(first);
    expect(controller.restart(false)).toBe(first);
    expect(driver.install).not.toHaveBeenCalled();
    downloaded.resolve();
    await first;
    expect(controller.getState().status).toBe("ready");
    const restart = controller.restart(false);
    expect(controller.restart(false)).toBe(restart);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(driver.install).not.toHaveBeenCalled();
    drained.resolve();
    await restart;
    expect(driver.download).toHaveBeenCalledOnce();
    expect(driver.install).toHaveBeenCalledOnce();
  });

  // Failed integrity verification or authorization must leave the old app
  // usable, with an explicit retry instead of a false ready/success state.
  test("does not permit restart after a failed download and supports retry", async () => {
    const download = vi.fn().mockRejectedValueOnce(new DesktopUpdateError("Verification failed.")).mockResolvedValue(undefined);
    const { controller, shutdown, driver } = fixture({ download });
    await controller.check();
    await controller.download();
    await controller.restart(false);
    expect(controller.getState()).toMatchObject({ status: "error", retry: "download" });
    expect(shutdown).not.toHaveBeenCalled();
    expect(driver.install).not.toHaveBeenCalled();
    await controller.download();
    expect(controller.getState().status).toBe("ready");
  });

  test("authorization cancellation and Later leave the backend untouched", async () => {
    const prepareInstall = vi.fn().mockRejectedValueOnce(new DesktopUpdateError("Authorization cancelled.")).mockResolvedValue(undefined);
    const { controller, shutdown, confirmRestart, driver } = fixture({ prepareInstall });
    await controller.check();
    await controller.download();
    confirmRestart.mockResolvedValueOnce(false);
    await controller.restart(true);
    expect(controller.getState().status).toBe("ready");
    expect(prepareInstall).not.toHaveBeenCalled();
    await controller.restart(true);
    expect(controller.getState()).toMatchObject({ status: "error", retry: "restart" });
    expect(shutdown).not.toHaveBeenCalled();
    expect(driver.install).not.toHaveBeenCalled();
    await controller.restart(true);
    expect(driver.install).toHaveBeenCalledOnce();
  });

  test("a rejected release check cannot reuse an earlier unvalidated feed", async () => {
    const check = vi.fn().mockResolvedValueOnce("0.3.0").mockRejectedValueOnce(new Error("Invalid manifest"));
    const { controller, driver } = fixture({ check });
    await controller.check();
    await controller.check();
    await controller.download();
    expect(driver.download).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ status: "error", retry: "check" });
  });

  test("recovers after teardown failure without invoking the installer", async () => {
    const { controller, driver, shutdown, recoverAfterShutdown } = fixture();
    await controller.check();
    await controller.download();
    shutdown.mockRejectedValue(new Error("Backend did not exit"));
    await controller.restart(false);
    expect(driver.install).not.toHaveBeenCalled();
    expect(recoverAfterShutdown).toHaveBeenCalledOnce();
  });

  test("invalidates readiness when a cached download is corrupted before install", async () => {
    const prepareInstall = vi.fn().mockRejectedValueOnce(new DesktopUpdateError("Cached file changed", "download")).mockResolvedValue(undefined);
    const { controller, driver, shutdown } = fixture({ prepareInstall });
    await controller.check();
    await controller.download();
    await controller.restart(false);
    expect(controller.getState()).toMatchObject({ status: "error", retry: "download" });
    await controller.restart(false);
    expect(shutdown).not.toHaveBeenCalled();
    await controller.download();
    await controller.restart(false);
    expect(driver.install).toHaveBeenCalledOnce();
  });
});
