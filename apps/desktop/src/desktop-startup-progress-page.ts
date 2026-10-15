/** Kept separate from Electron so the startup screen can be rendered for review. */
export function startupProgressHtml(themeCss: string, theme: string, appName: string, iconDataUrl: string): string {
  const escapedName = appName.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
  return `<!doctype html><html data-theme="${theme === "dark" ? "dark" : "light"}"><head><meta charset="utf-8"><title>${escapedName}</title><style>
${themeCss}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--surface-page); color: var(--text-primary); font-family: system-ui, sans-serif; -webkit-app-region: drag; }
/* Match the renderer's icon-only opening frame while the server starts. */
img { display: block; width: 70px; height: 70px; object-fit: contain; }
.progress { position: absolute; top: calc(50% + 70px); left: 24px; right: 24px; text-align: center; }
p { margin: 0; color: var(--text-secondary); font-size: 14px; line-height: 1.6; }
.startup-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
progress { width: 220px; height: 5px; margin-top: 22px; accent-color: var(--action-primary); }
@media (max-width: 380px) { img { width: 62px; height: 62px; } }
</style></head><body><main role="status" aria-live="polite"><img alt="OpenPond" src="${iconDataUrl}"><div class="progress"><p class="startup-status" id="openpond-startup-message">Starting OpenPond</p><progress id="openpond-startup-progress" max="100" hidden aria-label="Saving recovery copy"></progress></div></main></body></html>`;
}
