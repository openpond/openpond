import { createRef } from "react";
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeEvent } from "@openpond/contracts";

import { DiagnosticsSettingsSection } from "../apps/web/src/components/settings/DiagnosticsSettingsSection";

describe("DiagnosticsSettingsSection", () => {
  test("surfaces saved diagnostic errors in settings", () => {
    const html = renderToStaticMarkup(
      createElement(DiagnosticsSettingsSection, {
        diagnostics: [
          diagnosticEvent("diag-1", "2026-07-07T12:00:00.000Z", "First saved error", 1),
          diagnosticEvent("diag-2", "2026-07-07T12:01:00.000Z", "Latest saved error", 2),
        ],
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
      }),
    );

    expect(html).toContain("Recent errors");
    expect(html).toContain("2 saved");
    expect(html).toContain("Latest saved error");
    expect(html).toContain("First saved error");
    expect(html.indexOf("Latest saved error")).toBeLessThan(html.indexOf("First saved error"));
  });
});

function diagnosticEvent(id: string, timestamp: string, output: string, sequence: number): RuntimeEvent {
  return {
    id,
    sequence,
    name: "diagnostic",
    timestamp,
    source: "server",
    status: "failed",
    output,
    data: {
      kind: "client_error",
      surface: "app",
    },
  };
}
