import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AppToast } from "../apps/web/src/components/app-shell/AppToast";
import { appErrorToastMessage } from "../apps/web/src/hooks/useAppErrorReporter";

const noop = () => undefined;

describe("AppToast", () => {
  test("renders diagnostics and dismiss actions as right-aligned icon controls", () => {
    const html = renderToStaticMarkup(
      createElement(AppToast, {
        toast: {
          id: 1,
          message: "Couldn’t connect to OpenPond.",
          tone: "error",
          actionLabel: "Open diagnostics settings",
          actionIcon: "settings",
          onAction: noop,
          dismissible: true,
        },
        onDismiss: noop,
      }),
    );

    expect(html).toContain('class="app-toast-actions"');
    expect(html).toContain('class="app-toast-icon-action"');
    expect(html).toContain('aria-label="Open diagnostics settings"');
    expect(html).toContain('aria-label="Dismiss notification"');
    expect(html).not.toContain(">Settings<");
  });

  test("replaces the browser fetch failure with a useful connection message", () => {
    expect(appErrorToastMessage("Failed to fetch")).toBe("Couldn’t connect to OpenPond.");
    expect(appErrorToastMessage("Error: Failed to fetch")).toBe("Couldn’t connect to OpenPond.");
    expect(appErrorToastMessage("TypeError: Failed to fetch")).toBe("Couldn’t connect to OpenPond.");
    expect(appErrorToastMessage("NetworkError when attempting to fetch resource.")).toBe(
      "Couldn’t connect to OpenPond.",
    );
    expect(appErrorToastMessage("Load failed")).toBe("Couldn’t connect to OpenPond.");
    expect(appErrorToastMessage("Something specific failed")).toBe("Something specific failed");
  });
});
