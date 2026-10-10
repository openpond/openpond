import { UI_THEME_COLORS } from "./ui-theme.generated.js";
import { z } from "zod";
import { FileOutputRefSchema } from "./work-outputs.js";
export const HTML_VISUAL_MAX_BYTES = 64000;
export const HTML_VISUAL_MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
export const HTML_VISUAL_MAX_HEIGHT = 2400;
export const HTML_VISUAL_WIDTH = 680;
// Published visuals use this small, stable variable vocabulary. Resolve it from the app palette.
export const HTML_VISUAL_THEME_TOKENS = {
  "--bg": "--surface-page", "--panel": "--surface-panel", "--panel-soft": "--surface-raised",
  "--text": "--text-primary", "--muted": "--text-muted", "--border": "--border-default",
  "--orange": "--accent-warm", "--cyan": "--accent-primary", "--blue": "--accent-info",
} as const;
export const HTML_VISUAL_THEME = {
  ...Object.fromEntries(Object.entries(HTML_VISUAL_THEME_TOKENS).map(([name, token]) => [name, UI_THEME_COLORS.dark[token]])) as Record<keyof typeof HTML_VISUAL_THEME_TOKENS, string>,
  "--font-web": '\"Figtree\",Inter,system-ui,sans-serif',
  "--color-scheme": "dark",
} as const;
export type HtmlVisualTheme = Record<keyof typeof HTML_VISUAL_THEME, string>;
export const HtmlVisualThemeSchema = z.record(z.enum(Object.keys(HTML_VISUAL_THEME) as [
  keyof HtmlVisualTheme,
  ...(keyof HtmlVisualTheme)[]
]), z.string().min(1).max(300));
export const HtmlVisualMeasureSchema = z.object({ width: z.number().int().min(280).max(1440), height: z.number().int().min(80).max(HTML_VISUAL_MAX_HEIGHT) });
export const HtmlVisualReferenceSchema = z.object({
  visualId: z.string().regex(/^visual_[a-f0-9]{32}$/),
  publicationId: z.string().regex(/^visual_pub_[a-f0-9]{32}$/),
  sessionId: z.string().min(1), turnId: z.string().min(1),
  output: FileOutputRefSchema,
  heights: z.array(HtmlVisualMeasureSchema).min(1).max(4),
});
export type HtmlVisualReference = z.infer<typeof HtmlVisualReferenceSchema>;
export const HtmlVisualPreviewRequestSchema = z.object({
  html: z.string().min(1).max(HTML_VISUAL_MAX_BYTES),
  width: z.number().int().min(280).max(1440).default(HTML_VISUAL_WIDTH),
  assets: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), path: z.string().min(1).max(4096) })).max(8).default([]),
});
export const HtmlVisualRenderRequestSchema = z.object({
  previewId: z.string().uuid(), title: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "Use a single-line title without control characters."),
  visualId: z.string().regex(/^visual_[a-f0-9]{32}$/).optional(),
});
export const HtmlVisualCaptureSchema = z.object({
  screenshots: z.array(z.string().min(1).max(5600000)).min(1).max(2),
  heights: z.array(HtmlVisualMeasureSchema).min(1).max(4),
  console: z.array(z.object({ level: z.enum(["log", "warn", "error"]), text: z.string().max(2000) })).max(40),
}).refine(value => value.screenshots.length === value.heights.length, "Each measured width needs a screenshot.");
export type HtmlVisualCapture = z.infer<typeof HtmlVisualCaptureSchema>;
export const HTML_VISUAL_INSTRUCTIONS = `When a comparison, relationship or interactive explanation would make your answer clearer, use html_preview to inspect a self-contained HTML visual, correct rendering problems, then publish the checked preview with html_render. The visual appears in the conversation. Use normal prose when a visual adds little. Keep calculations faithful to the supplied data and accompany the visual with useful interpretation. Pages have no network or host-tool access. Use accessible HTML, SVG or canvas and the supplied OpenPond theme variables; no external libraries are needed. A publication returns its visualId; use it when revising that same visual.`;
export const HTML_VISUAL_LAYOUT = `The document is part of a chat reply: leave the outer background transparent, use fluid width, avoid an outer card/banner and unnecessary outer padding. Let content determine height (no 100vh or height:100%). Give filled inner panels comfortable padding and rounded corners. Use the injected CSS variables --bg, --panel, --panel-soft, --text, --muted, --border, --font-web, --orange, --cyan and --blue. These follow the app's active colors. Use labeled keyboard-operable controls and respect reduced motion. Check the returned desktop and narrow measurements. Inline style/script, SVG/canvas, and bundled raster images work; network, navigation, frames, workers, forms and host access do not. For local images pass assets with a name and an authorized workspace path and reference asset:NAME in the HTML. Maximum HTML is 64,000 UTF-8 bytes; at most eight raster assets, 4 MiB total.`;
