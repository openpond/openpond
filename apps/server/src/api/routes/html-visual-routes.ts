import { sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
// Authenticated data, never executable HTML on the application origin. Clients
// render through the shared double-sandbox document; downloads are attachments.
export async function handleHtmlVisualRoutes({ deps, request, requestUrl, response }: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/sessions\/([^/]+)\/visuals\/(visual_pub_[a-f0-9]{32})\/(document|source|preview)$/.exec(requestUrl.pathname);
  if (!match || request.method !== 'GET')
    return false;
  if (!deps.htmlVisuals) {
    sendJson(response, 404, { error: 'Visuals are unavailable.' });
    return true;
  }
  try {
    const result = await deps.htmlVisuals.read(decodeURIComponent(match[1]!), match[2]!, match[3] === 'preview' ? 'png' : 'html');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (match[3] === 'document')
      sendJson(response, 200, { html: result.bytes.toString('utf8'), visual: result.reference });
    else {
      response.setHeader('Content-Type', match[3] === 'preview' ? 'image/png' : 'text/html; charset=utf-8');
      if (match[3] === 'source')
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.reference.output.title + '.html')}`);
      response.end(result.bytes);
    }
  }
  catch {
    sendJson(response, 404, { error: 'Visual is unavailable.' });
  }
  return true;
}
