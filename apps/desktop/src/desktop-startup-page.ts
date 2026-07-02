import type { BrowserWindow } from "electron";
import { appDisplayName } from "./desktop-environment.js";

export async function showLoadError(window: BrowserWindow, error: unknown): Promise<void> {
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
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${appDisplayName()}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050608; color: white; font-family: system-ui, sans-serif; }
          main { width: min(680px, calc(100vw - 48px)); padding: 24px; border: 1px solid rgba(255,255,255,.12); background: #0a0f16; border-radius: 6px; }
          h1 { margin: 0 0 10px; font-size: 18px; }
          p { margin: 0 0 16px; color: #cbd5e1; line-height: 1.5; }
          pre { white-space: pre-wrap; color: #fca5a5; font-size: 13px; padding: 12px; background: rgba(255,255,255,.04); border-radius: 6px; overflow-wrap: anywhere; }
          .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
          button { appearance: none; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; background: #172033; color: white; padding: 9px 12px; font: inherit; cursor: pointer; }
          button.primary { background: #2563eb; border-color: #2563eb; }
          button:hover { filter: brightness(1.1); }
          #status { min-height: 18px; margin-top: 12px; color: #93c5fd; font-size: 13px; }
        </style>
      </head>
      <body>
        <main>
          <h1>${appDisplayName()} could not start</h1>
          <p>The app hit a startup error. The details are also written to local logs.</p>
          <pre>${escaped}</pre>
          <div class="actions">
            <button class="primary" id="retry">Retry</button>
            <button id="logs">Open Logs</button>
            <button id="diagnostics">Export Diagnostics</button>
          </div>
          <div id="status"></div>
        </main>
        <script>
          const status = document.getElementById("status");
          async function run(label, fn) {
            status.textContent = label;
            try {
              const result = await fn();
              status.textContent = result && result.error ? result.error : "";
            } catch (error) {
              status.textContent = error && error.message ? error.message : String(error);
            }
          }
          document.getElementById("retry").addEventListener("click", () => run("Retrying...", () => window.openpond.retryStartup()));
          document.getElementById("logs").addEventListener("click", () => run("Opening logs...", () => window.openpond.openLogsFolder()));
          document.getElementById("diagnostics").addEventListener("click", () => run("Exporting diagnostics...", () => window.openpond.exportDiagnostics()));
        </script>
      </body>
    </html>
  `)}`);
}
