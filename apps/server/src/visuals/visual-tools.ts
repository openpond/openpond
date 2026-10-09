import { z } from "zod";
import { HtmlVisualPreviewRequestSchema, HtmlVisualRenderRequestSchema, HTML_VISUAL_LAYOUT } from "@openpond/contracts/html-visuals";
import type { ModelToolDefinition } from "../openpond/model-tool-registry.js";
import type { HtmlVisualService } from "./visual-service.js";
export function visualTools(service?: HtmlVisualService): ModelToolDefinition[] {
  if (!service)
    return [];
  const enabled: NonNullable<ModelToolDefinition["enabled"]> = ({ session }) => !session.systemKind && service.available();
  return [
    { name: 'html_preview', description: `Render a self-contained HTML visual in isolated desktop Chromium before publishing. Returns PNG images at desktop and narrow widths that you must inspect, content heights at desktop/narrow widths, console diagnostics and previewId. Fix errors and call again as needed. Drafts expire after 15 minutes. ${HTML_VISUAL_LAYOUT}`,
      parameters: z.toJSONSchema(HtmlVisualPreviewRequestSchema), enabled,
      execute: async (context) => {
        const result = await service.preview(context, context.args);
        const { screenshots, ...receipt } = result;
        return { toolCallId: context.callId, name: 'html_preview', ok: true, contentText: JSON.stringify(receipt), data: receipt, images: screenshots.map(data => ({ mimeType: 'image/png', data })) };
      } },
    { name: 'html_render', description: 'Publish the exact checked HTML from previewId as an interactive visual in this conversation. Supply a short title; supply the returned visualId when revising an existing visual in this conversation. Does not share or deploy anything externally. The reader sees the visual inline, so add interpretation rather than repeating its contents.',
      parameters: z.toJSONSchema(HtmlVisualRenderRequestSchema), enabled,
      execute: async (context) => {
        if (!service.available())
          throw new Error('Desktop preview host is disconnected.');
        const visual = await service.render(context, context.args);
        return { toolCallId: context.callId, name: 'html_render', ok: true, contentText: JSON.stringify({ visualId: visual.visualId, publicationId: visual.publicationId, revision: visual.output.revision, title: visual.output.title }), data: { visual } };
      } },
  ];
}
