import { describe, expect, test } from "bun:test";
import { createElement, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatProvider, InsightsEvidenceSourceSettings } from "@openpond/contracts";

import { DefaultsSettingsSection } from "../apps/web/src/components/settings/DefaultsSettingsSection";
import { DEFAULT_APP_PREFERENCES } from "../apps/web/src/lib/app-models";

function renderDefaultsSettings(input: { autoEnabled?: boolean } = {}): string {
  const preferences = {
    ...DEFAULT_APP_PREFERENCES,
    contextCompaction: {
      ...DEFAULT_APP_PREFERENCES.contextCompaction,
      autoEnabled: input.autoEnabled ?? DEFAULT_APP_PREFERENCES.contextCompaction.autoEnabled,
    },
  };
  return renderToStaticMarkup(
    createElement(DefaultsSettingsSection, {
      advancedWorkspaceControls: preferences.advancedWorkspaceControls,
      contextCompactionAutoEnabled: preferences.contextCompaction.autoEnabled,
      defaultBranchPrefix: preferences.defaultBranchPrefix,
      defaultNewProjectDirectory: preferences.defaultNewProjectDirectory,
      goalStorageLocation: preferences.goalStorageLocation,
      insightsEnabled: preferences.insightsEnabled,
      insightsUseDefaultModel: true,
      insightsProvider: preferences.defaultChatProvider,
      insightsModel: preferences.defaultChatModel,
      insightsEvidenceSources: preferences.insightsEvidenceSources,
      preferences,
      providers: null,
      saving: false,
      chooseDefaultProjectDirectory: () => undefined,
      saveDefaults: (_event: FormEvent<HTMLFormElement>) => undefined,
      changeInsightsProvider: (_provider: ChatProvider) => undefined,
      setAdvancedWorkspaceControls: (_value: boolean) => undefined,
      setContextCompactionAutoEnabled: (_value: boolean) => undefined,
      setDefaultBranchPrefix: (_value: string) => undefined,
      setDefaultNewProjectDirectory: (_value: string) => undefined,
      setGoalStorageLocation: (_value: typeof preferences.goalStorageLocation) => undefined,
      setInsightsEnabled: (_value: boolean) => undefined,
      setInsightsUseDefaultModel: (_value: boolean) => undefined,
      setInsightsModel: (_value: string) => undefined,
      setInsightsEvidenceSourceEnabled: (_key: keyof InsightsEvidenceSourceSettings, _enabled: boolean) =>
        undefined,
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

describe("DefaultsSettingsSection", () => {
  test("surfaces auto context compaction as a default-on setting", () => {
    const html = renderDefaultsSettings();

    expect(html).toContain("Context");
    expect(html).toContain("Auto compact long chats");
    expect(html).toContain("Summarize older turns at 85% context");
    expect(html).toContain("The transcript stays visible.");
    expect(autoCompactionInputMarkup(html)).toContain("checked");
  });

  test("renders the saved-off state", () => {
    const html = renderDefaultsSettings({ autoEnabled: false });

    expect(html).toContain("Auto compact long chats");
    expect(autoCompactionInputMarkup(html)).not.toContain("checked");
  });
});
