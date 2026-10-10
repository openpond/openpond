import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";

const bootstrap = readFileSync(new URL("../apps/web/public/appearance.js", import.meta.url), "utf8");

function browser(saved: string | null, dark = false, storageBlocked = false) {
  const window = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: dark });
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const setAppearance = vi.fn(async () => {});
  Object.assign(window, { openpond: { setAppearance } });
  runInNewContext(bootstrap, {
    window, document: { documentElement: root }, Event, console,
    matchMedia: () => media,
    localStorage: { getItem: () => { if (storageBlocked) throw new Error("Unavailable"); return saved; } },
  });
  return {
    root, setAppearance,
    system(value: boolean) { media.matches = value; media.dispatchEvent(new Event("change")); },
    preference(value: string) { window.dispatchEvent(Object.assign(new Event("openpond:appearance"), { detail: value })); },
    storage(value: string | null, key: string | null = "openpond:appearance") {
      window.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: value }));
    },
  };
}

// A stale system listener must not undo an explicit user choice; reload and other tabs must agree.
test("applies the saved preference before rendering and follows system changes only in System mode", () => {
  const app = browser("dark", false);
  expect(app.root.dataset).toEqual({ theme: "dark", themePreference: "dark" });
  app.system(false);
  expect(app.root.dataset.theme).toBe("dark");
  app.preference("system");
  expect(app.root.dataset.theme).toBe("light");
  app.system(true);
  expect(app.root.dataset.theme).toBe("dark");
  app.preference("light");
  app.system(true);
  expect(app.root.dataset.theme).toBe("light");
  app.storage("dark", "another-setting");
  expect(app.root.dataset.theme).toBe("light");
  app.storage("dark");
  expect(app.root.dataset.theme).toBe("dark");
  app.storage(null, null);
  expect(app.root.dataset.themePreference).toBe("system");
  expect(app.root.style.colorScheme).toBe("dark");
  expect(app.setAppearance).toHaveBeenLastCalledWith("system");
  expect(browser("light", true).root.dataset.theme).toBe("light");
});

// An invalid/blocked preference must never prevent the app from starting.
test("starts with the system theme when storage is unavailable or contains an invalid preference", () => {
  expect(browser("invalid", true).root.dataset.theme).toBe("dark");
  expect(browser(null, false, true).root.dataset.theme).toBe("light");
});
