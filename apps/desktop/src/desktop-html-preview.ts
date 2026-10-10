import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { htmlVisualDocument } from "@openpond/contracts/html-visual-document";
import { HTML_VISUAL_MAX_BUNDLE_BYTES, HTML_VISUAL_MAX_HEIGHT, HTML_VISUAL_THEME, HTML_VISUAL_THEME_TOKENS, HtmlVisualThemeSchema, type HtmlVisualCapture } from "@openpond/contracts/html-visuals";
const RequestSchema = z.object({ id: z.string().min(1), deadlineAt: z.string(), operation: z.literal('previewHtml'), input: z.object({ html: z.string().min(1).max(HTML_VISUAL_MAX_BUNDLE_BYTES), width: z.number().int().min(280).max(1440) }) });
export async function captureHtmlVisual(raw: unknown, appWindow: BrowserWindow, signal: AbortSignal): Promise<HtmlVisualCapture> {
  const request = RequestSchema.parse(raw);
  if (Buffer.byteLength(request.input.html) > HTML_VISUAL_MAX_BUNDLE_BYTES)
    throw new Error('Visual is too large.');
  const remaining = Date.parse(request.deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error('Preview request expired.');
  const isolated = session.fromPartition(`html-preview-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') && !details.url.startsWith('about:') }));
  // Hidden native windows can retain only their initial viewport pixels after
  // resize. Offscreen rendering paints the entire measured preview surface.
  const window = new BrowserWindow({ show: false, width: request.input.width, height: 100, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const stop = () => { if (!window.isDestroyed())
    window.destroy(); };
  const timeout = setTimeout(stop, Math.min(15000, remaining));
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const theme = HtmlVisualThemeSchema.parse(await appWindow.webContents.executeJavaScript(`Object.fromEntries(${JSON.stringify(Object.keys(HTML_VISUAL_THEME))}.map(k=>[k,k==='--color-scheme'?(document.documentElement.dataset.theme||'dark'):getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(HTML_VISUAL_THEME_TOKENS)}[k]||k).trim()||${JSON.stringify(HTML_VISUAL_THEME)}[k]]))`));
    window.setBackgroundColor(theme["--bg"]);
    const html = htmlVisualDocument(request.input.html, request.id, theme);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const heights: HtmlVisualCapture['heights'] = [];
    const screenshots: string[] = [];
    let console: HtmlVisualCapture['console'] = [];
    for (const width of [...new Set([request.input.width, 360])]) {
      window.setContentSize(width, 100);
      let previous = 0, stable = 0, height = 80;
      for (let attempt = 0; attempt < 35; attempt++) {
        signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 80));
        if (window.isDestroyed())
          throw new Error('HTML preview timed out or was cancelled.');
        const state = await window.webContents.executeJavaScript('window.__openpondVisual') as {
          ready: boolean;
          height: number;
          console: HtmlVisualCapture['console'];
        };
        if (!state?.ready)
          continue;
        height = Math.max(80, Math.min(HTML_VISUAL_MAX_HEIGHT, state.height));
        stable = height === previous ? stable + 1 : 0;
        previous = height;
        window.setContentSize(width, height);
        console = state.console;
        if (stable >= 3)
          break;
      }
      if (!previous)
        throw new Error('The page did not report a content height.');
      heights.push({ width, height });
      const image = await window.webContents.capturePage();
      const screenshot = image.toPNG().toString('base64');
      if (screenshot.length > 5600000)
        throw new Error('Preview image is too large. Simplify the visual.');
      screenshots.push(screenshot);
    }
    return { screenshots, heights, console };
  }
  finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    stop();
    await isolated.clearStorageData();
    await isolated.clearCache();
  }
}
