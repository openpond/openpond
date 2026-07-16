import { describe, expect, test } from "vitest";
import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextSettingsSection } from "../apps/web/src/components/settings/HarnessSettingsSections";
import { DEFAULT_APP_PREFERENCES } from "../apps/web/src/lib/app-models";

function renderContextSettings(input: { autoEnabled?: boolean } = {}): string {
  const preferences = {
    ...DEFAULT_APP_PREFERENCES,
    contextCompaction: {
      ...DEFAULT_APP_PREFERENCES.contextCompaction,
      autoEnabled: input.autoEnabled ?? DEFAULT_APP_PREFERENCES.contextCompaction.autoEnabled,
    },
  };
  return renderToStaticMarkup(
    createElement(ContextSettingsSection, {
      contextCompactionAutoEnabled: preferences.contextCompaction.autoEnabled,
      preferences,
      saving: false,
      saveDefaults: (_event: FormEvent<HTMLFormElement>) => undefined,
      setContextCompactionAutoEnabled: (_value: boolean) => undefined,
    }),
  );
}

function autoCompactionInputMarkup(html: string): string {
  const markerIndex = html.indexOf("<strong>Auto compact long chats</strong>");
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const inputStart = html.lastIndexOf("<input", markerIndex);
  const inputEnd = html.indexOf(">", inputStart);
  return html.slice(inputStart, inputEnd + 1);
}

describe("ContextSettingsSection", () => {
  test("surfaces auto context compaction as a default-on setting", () => {
    const html = renderContextSettings();

    expect(html).toContain("Context");
    expect(html).toContain("Auto compact long chats");
    expect(html).toContain("Summarize older turns at 85% context");
    expect(html).toContain("The transcript stays visible.");
    expect(autoCompactionInputMarkup(html)).toContain("checked");
  });

  test("renders the saved-off state", () => {
    const html = renderContextSettings({ autoEnabled: false });

    expect(html).toContain("Auto compact long chats");
    expect(autoCompactionInputMarkup(html)).not.toContain("checked");
  });
});
