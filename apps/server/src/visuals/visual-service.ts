import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { publishManagedArtifact, releaseArtifactReference, withManagedArtifact } from "@openpond/persistence";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { HtmlVisualCaptureSchema, HtmlVisualPreviewRequestSchema, HtmlVisualRenderRequestSchema, type HtmlVisualReference } from "@openpond/contracts/html-visuals";
import type { BrowserHarnessToolExecutor } from "../openpond/browser-tool-registry.js";
import { bundleVisualAssets } from "./visual-assets.js";
import { createVisualStore, type VisualPublication } from "./visual-store.js";
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const owner = (id: string, suffix = 'html') => ({ domain: 'chat_attachment' as const, id: `html-visual:${id}:${suffix}` });
type Draft = {
  sessionId: string;
  html: string;
  sha256: string;
  capture: ReturnType<typeof HtmlVisualCaptureSchema.parse>;
  expires: number;
};
export type HtmlVisualService = ReturnType<typeof createHtmlVisualService>;
export function createHtmlVisualService(deps: {
  home: string;
  executor: BrowserHarnessToolExecutor;
  getSession(id: string): Promise<Session | null>;
  events(id: string): Promise<RuntimeEvent[]>;
  append(event: RuntimeEvent): Promise<void>;
}) {
  const store = createVisualStore(deps.home);
  const drafts = new Map<string, Draft>();
  let previewing = 0;
  const locks = new Map<string, Promise<unknown>>();
  async function locked<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const next = (locks.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    locks.set(sessionId, next);
    try {
      return await next;
    }
    finally {
      if (locks.get(sessionId) === next)
        locks.delete(sessionId);
    }
  }
  async function finish(publication: VisualPublication) {
    if (publication.ready)
      return publication.reference;
    const ref = publication.reference;
    if (!await deps.getSession(ref.sessionId))
      throw new Error('Visual conversation is unavailable.');
    if (publication.document !== null)
      await publishManagedArtifact(deps.home, { owner: owner(ref.publicationId), displayName: `${ref.output.title}.html`, mediaType: 'text/html', bytes: Buffer.from(publication.document) });
    if (publication.screenshot !== null)
      await publishManagedArtifact(deps.home, { owner: owner(ref.publicationId, 'png'), displayName: 'Preview.png', mediaType: 'image/png', bytes: Buffer.from(publication.screenshot, 'base64') });
    const eventId = ref.publicationId;
    if (!(await deps.events(ref.sessionId)).some(event => event.id === eventId))
      await deps.append({ id: eventId, sessionId: ref.sessionId, turnId: ref.turnId, name: 'visual.published', timestamp: ref.output.createdAt, source: 'server', data: { visual: ref } });
    store.save({ ...publication, document: null, screenshot: null, ready: true });
    return ref;
  }
  async function release(publication: VisualPublication) {
    await releaseArtifactReference(deps.home, owner(publication.reference.publicationId));
    await releaseArtifactReference(deps.home, owner(publication.reference.publicationId, 'png'));
    store.delete(publication.reference.publicationId);
  }
  return {
    available() { return !!deps.executor.previewHtml && deps.executor.visualAvailable?.() === true; },
    async recover() {
      for (const publication of store.list()) {
        if (!await deps.getSession(publication.reference.sessionId)) {
          await release(publication);
          continue;
        }
        if (!publication.ready)
          await locked(publication.reference.sessionId, () => finish(publication));
      }
    },
    async preview(context: {
      session: Session;
      turnId: string;
      callId: string;
      signal: AbortSignal;
    }, args: unknown) {
      const input = HtmlVisualPreviewRequestSchema.parse(args);
      if (!deps.executor.previewHtml || !deps.executor.visualAvailable?.())
        throw new Error('This desktop does not support HTML previews.');
      context.signal.throwIfAborted();
      for (const [id, draft] of drafts)
        if (draft.expires < Date.now())
          drafts.delete(id);
      if (drafts.size + previewing >= 16)
        throw new Error('There are too many draft visuals. Finish an existing preview or retry after drafts expire.');
      previewing++;
      try {
        const html = await bundleVisualAssets(input.html, input.assets, context.session.cwd);
        const result = await deps.executor.previewHtml({ ...context, sessionId: context.session.id, conversationId: context.session.id, html, width: input.width });
        if (!result.ok)
          throw new Error(result.output);
        const capture = HtmlVisualCaptureSchema.parse(result.data);
        context.signal.throwIfAborted();
        const previewId = randomUUID(), sha256 = digest(html);
        drafts.set(previewId, { sessionId: context.session.id, html, sha256, capture, expires: Date.now() + 15 * 60000 });
        return { previewId, sha256, heights: capture.heights, console: capture.console, screenshots: capture.screenshots };
      }
      finally {
        previewing--;
      }
    },
    async render(context: {
      session: Session;
      turnId: string;
      callId: string;
      signal: AbortSignal;
    }, args: unknown) {
      const input = HtmlVisualRenderRequestSchema.parse(args);
      return locked(context.session.id, async () => {
        context.signal.throwIfAborted();
        const callKey = digest(JSON.stringify([context.session.id, context.turnId, context.callId]));
        const existing = store.byCall(callKey);
        if (existing)
          return finish(existing);
        const draft = drafts.get(input.previewId);
        if (!draft || draft.sessionId !== context.session.id || draft.expires < Date.now())
          throw new Error('Preview expired or belongs to another conversation. Preview the document again.');
        if (draft.capture.console.some(row => row.level === 'error'))
          throw new Error('The preview has script or resource errors. Correct them and preview again before publishing.');
        const prior = store.list(context.session.id).filter(row => row.reference.visualId === input.visualId).sort((a, b) => b.reference.output.revision - a.reference.output.revision)[0];
        if (input.visualId && !prior)
          throw new Error('The visual to revise does not belong to this conversation.');
        const publicationId = `visual_pub_${callKey.slice(0, 32)}`, visualId = input.visualId ?? `visual_${callKey.slice(0, 32)}`;
        const reference: HtmlVisualReference = { visualId, publicationId, sessionId: context.session.id, turnId: context.turnId, heights: draft.capture.heights,
          output: { kind: 'file', id: visualId, title: input.title, sourceTaskId: context.session.id, sourceTurnId: context.turnId, revision: (prior?.reference.output.revision ?? 0) + 1, createdAt: new Date().toISOString(), contentType: 'text/html', sizeBytes: Buffer.byteLength(draft.html), sha256: draft.sha256,
            location: { kind: 'managed', fileId: publicationId, downloadPath: `/v1/sessions/${encodeURIComponent(context.session.id)}/visuals/${publicationId}/source` },
            validation: [{ kind: 'visual', status: 'passed', label: 'Desktop HTML preview', detail: `Rendered at ${draft.capture.heights.map(row => row.width).join(' and ')}px; no script or resource errors.` }] } };
        const publication: VisualPublication = { reference, callKey, document: draft.html, screenshot: draft.capture.screenshots[0]!, ready: false };
        store.save(publication);
        // Once the intent is durable, finish publication even if the caller
        // disconnects. Retrying and startup recovery complete the same event.
        const referenceResult = await finish(publication);
        drafts.delete(input.previewId);
        return referenceResult;
      });
    },
    async read(sessionId: string, publicationId: string, kind: 'html' | 'png' = 'html') {
      const publication = store.get(publicationId);
      if (!publication || publication.reference.sessionId !== sessionId || !publication.ready || !await deps.getSession(sessionId))
        throw new Error('Visual is unavailable.');
      const bytes = await withManagedArtifact(deps.home, owner(publicationId, kind), file => fs.readFile(file));
      return { reference: publication.reference, bytes };
    },
    async removeSession(sessionId: string) { await locked(sessionId, async () => { for (const publication of store.list(sessionId))
      await release(publication); for (const [id, draft] of drafts)
      if (draft.sessionId === sessionId)
        drafts.delete(id); }); },
  };
}
