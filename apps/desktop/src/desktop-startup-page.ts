import { UI_THEME_CSS } from "@openpond/contracts/ui-theme.generated";
import { resolvedDesktopTheme } from "./desktop-appearance.js";
import type { BrowserWindow } from "electron";
import { appDisplayName } from "./desktop-environment.js";

export async function showLoadError(window: BrowserWindow, error: unknown, onPageUrl: (url: string) => void): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = message.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
  const pageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html data-theme="${resolvedDesktopTheme()}">
      <head>
        <meta charset="utf-8" />
        <title>${appDisplayName()}</title>
        <style>
          ${UI_THEME_CSS}
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--surface-page); color: var(--text-primary); font-family: system-ui, sans-serif; }
          main { width: min(680px, calc(100vw - 48px)); padding: 24px; border: 1px solid var(--border-default); background: var(--surface-panel); border-radius: 6px; }
          h1 { margin: 0 0 10px; font-size: 18px; }
          p { margin: 0 0 16px; color: var(--text-secondary); line-height: 1.5; }
          pre { white-space: pre-wrap; color: var(--status-danger); font-size: 13px; padding: 12px; background: var(--surface-raised); border-radius: 6px; overflow-wrap: anywhere; }
          .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
          button { appearance: none; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface-input); color: var(--text-primary); padding: 9px 12px; font: inherit; cursor: pointer; }
          button.primary { background: var(--action-primary); border-color: var(--action-primary); color: var(--text-on-primary); }
          button:hover { filter: brightness(1.1); }
          #status { min-height: 18px; margin-top: 12px; color: var(--status-info); font-size: 13px; }
        </style>
      </head>
      <body>
        <main>
          <h1>${appDisplayName()} needs recovery</h1>
          <p>The app could not load after retrying. The details are also written to local logs.</p>
          <pre>${escaped}</pre>
          <div class="actions">
            <button class="primary" id="retry">Retry</button>
            <button id="restart">Restart App</button>
            <button id="logs">Open Logs</button>
            <button id="diagnostics">Export Diagnostics</button>
          </div>
          <div id="status"></div>
        </main>
        <script>
          const status = document.getElementById("status");
          async function run(label, fn, button) {
            if (button && button.disabled) return;
            if (button) button.disabled = true;
            status.textContent = label;
            try {
              const result = await fn();
              status.textContent = result && result.error ? result.error : "";
            } catch (error) {
              status.textContent = error && error.message ? error.message : String(error);
            } finally {
              if (button) button.disabled = false;
            }
          }
          document.getElementById("retry").addEventListener("click", (event) => run("Retrying...", () => window.openpond.retryStartup(), event.currentTarget));
          document.getElementById("restart").addEventListener("click", (event) => run("Restarting...", () => window.openpond.restartDesktopApp(), event.currentTarget));
          document.getElementById("logs").addEventListener("click", () => run("Opening logs...", () => window.openpond.openLogsFolder()));
          document.getElementById("diagnostics").addEventListener("click", () => run("Exporting diagnostics...", () => window.openpond.exportDiagnostics()));
        </script>
      </body>
    </html>
  `)}`;
  onPageUrl(pageUrl);
  await window.loadURL(pageUrl);
}
