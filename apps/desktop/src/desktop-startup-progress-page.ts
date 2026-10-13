/** Kept separate from Electron so the startup screen can be rendered for review. */
export function startupProgressHtml(themeCss: string, theme: string, appName: string): string {
  const escapedName = appName.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
  return `<!doctype html><html data-theme="${theme === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><title>${escapedName}</title><style>
${themeCss}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--surface-page); color: var(--text-primary); font-family: system-ui, sans-serif; -webkit-app-region: drag; }
main { width: min(420px, calc(100vw - 64px)); text-align: center; }
h1 { margin: 0 0 20px; font-size: 22px; font-weight: 600; }
p { margin: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
progress { width: 220px; height: 5px; margin-top: 22px; accent-color: var(--action-primary); }
</style></head><body><main role="status" aria-live="polite"><h1>${escapedName}</h1><p id="openpond-startup-message">Starting OpenPond</p><progress id="openpond-startup-progress" max="100" hidden aria-label="Saving recovery copy"></progress></main></body></html>`;
}
