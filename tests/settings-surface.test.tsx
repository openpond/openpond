import { createElement, createRef, type FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";

import { DiagnosticsSettingsSection } from "../apps/web/src/components/settings/DiagnosticsSettingsSection";
import { ContextSettingsSection } from "../apps/web/src/components/settings/HarnessSettingsSections";
import { SettingsNavigation } from "../apps/web/src/components/settings/SettingsNavigation";
import { DEFAULT_APP_PREFERENCES } from "../apps/web/src/lib/app-models";

describe("settings surface", () => {
  test("keeps primary destinations ordered and marks the selected section", () => {
    const markup = renderToStaticMarkup(createElement(SettingsNavigation, {
      section: "notifications",
      onBack: () => undefined,
      onSectionChange: () => undefined,
    }));
    expect(markup.indexOf("Account")).toBeLessThan(markup.indexOf("Notifications"));
    expect(markup.indexOf("Notifications")).toBeLessThan(markup.indexOf("Providers"));
    expect(markup.indexOf("Compute")).toBeLessThan(markup.indexOf("Dataset Storage"));
    expect(markup.indexOf("Dataset Storage")).toBeLessThan(markup.indexOf("Activity"));
    expect(markup).toContain('class="settings-nav-item active"');
  });

  test("keeps Harness controls together without legacy navigation", () => {
    const markup = renderToStaticMarkup(createElement(SettingsNavigation, {
      section: "training",
      onBack: () => undefined,
      onSectionChange: () => undefined,
    }));
    expect(markup.indexOf("Harness")).toBeLessThan(markup.indexOf("Profiles"));
    expect(markup.indexOf("Training")).toBeLessThan(markup.indexOf("Subagents"));
    expect(markup).not.toContain("Insights");
    expect(markup).not.toContain("Goals");
  });

  test("renders auto compaction from the persisted default", () => {
    const render = (autoEnabled: boolean) => renderToStaticMarkup(createElement(ContextSettingsSection, {
      contextCompactionAutoEnabled: autoEnabled,
      preferences: {
        ...DEFAULT_APP_PREFERENCES,
        contextCompaction: { ...DEFAULT_APP_PREFERENCES.contextCompaction, autoEnabled },
      },
      saving: false,
      saveDefaults: (_event: FormEvent<HTMLFormElement>) => undefined,
      setContextCompactionAutoEnabled: () => undefined,
    }));
    expect(render(true)).toMatch(/<input[^>]+checked[^>]*>.*Auto compact long chats/s);
    expect(render(false)).not.toMatch(/<input[^>]+checked[^>]*>.*Auto compact long chats/s);
  });

  test("shows saved diagnostic failures newest first", () => {
    const diagnostics = [
      diagnosticEvent("diag-1", "2026-07-07T12:00:00.000Z", "First saved error", 1),
      diagnosticEvent("diag-2", "2026-07-07T12:01:00.000Z", "Latest saved error", 2),
    ];
    const html = renderToStaticMarkup(createElement(DiagnosticsSettingsSection, {
      diagnostics,
      diagnosticsAvailable: true,
      diagnosticsBusy: null,
      diagnosticsStatus: null,
      logDir: null,
      logLineLimit: 100,
      logLines: [],
      logViewBusy: null,
      logViewSummary: "0 of 100 lines tailing",
      logViewportRef: createRef<HTMLDivElement>(),
      tailLogs: true,
      copyRecentLogs: async () => undefined,
      exportDiagnosticsBundle: async () => undefined,
      loadOlderLogs: () => undefined,
      openLogsFolder: async () => undefined,
      refreshLogView: async () => undefined,
      toggleTailLogs: () => undefined,
    }));
    expect(html).toContain("2 saved");
    expect(html.indexOf("Latest saved error")).toBeLessThan(html.indexOf("First saved error"));
  });
});

function diagnosticEvent(
  id: string,
  timestamp: string,
  output: string,
  sequence: number,
): RuntimeEvent {
  return {
    id,
    sequence,
    name: "diagnostic",
    timestamp,
    source: "server",
    status: "failed",
    output,
    data: { kind: "client_error", surface: "app" },
  };
}
