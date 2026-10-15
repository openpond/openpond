import { AppPreferencesSchema, type UpdateAppPreferencesRequest } from "@openpond/contracts";
import { expect, test, vi } from "vitest";
import type { PreferencesPayload } from "../api";
import { createLayoutPreferenceWriter } from "./layout-preference-writer";

// A slow narrow-width PATCH must not overwrite a later restore, lose another
// layout field, poison subsequent saves on failure, or publish into a new owner.
test("layout persistence keeps the latest gesture across pending writes, failure and disposal", async () => {
  let stored = AppPreferencesSchema.parse({ diffPanelWidth: 570, sidebarWidth: 320 });
  const calls: { patch: UpdateAppPreferencesRequest; complete(): void; fail(error: Error): void }[] = [];
  const applied: PreferencesPayload[] = [], errors: unknown[] = [];
  const writer = createLayoutPreferenceWriter({
    save: patch => new Promise<PreferencesPayload>((resolve, reject) => {
      calls.push({ patch, complete: () => { stored = { ...stored, ...patch }; resolve({ preferences: stored }); }, fail: reject });
    }),
    apply: payload => applied.push(payload),
    onError: error => errors.push(error),
  });
  const first = writer.write({ diffPanelWidth: 350 });
  const restore = writer.write({ diffPanelWidth: 570 });
  const mixed = writer.write({ sidebarWidth: 300 });
  expect(calls).toHaveLength(1);
  calls[0]!.complete();
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.patch).toEqual({ diffPanelWidth: 570, sidebarWidth: 300 });
  calls[1]!.complete();
  await Promise.all([first, restore, mixed]);
  expect(stored).toMatchObject({ diffPanelWidth: 570, sidebarWidth: 300 });
  expect(applied.at(-1)?.preferences).toBe(stored);

  const failed = writer.write({ diffPanelWidth: 400 });
  const recovered = writer.write({ diffPanelWidth: 570 });
  calls[2]!.fail(new Error("Save unavailable"));
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  calls[3]!.complete();
  await Promise.all([failed, recovered]);
  expect(errors).toHaveLength(1);
  expect(stored.diffPanelWidth).toBe(570);

  const oldOwner = writer.write({ diffPanelWidth: 450 });
  const oldQueued = writer.write({ diffPanelWidth: 570 });
  const published = applied.length;
  writer.dispose();
  calls[4]!.complete();
  await Promise.all([oldOwner, oldQueued]);
  expect(calls).toHaveLength(5);
  expect(applied).toHaveLength(published);
});
