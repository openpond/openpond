import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ChatAttachmentSummarySchema, type RuntimeEvent } from "@openpond/contracts";
import { codexHistorySessionId, readCodexHistoryThreadPayload } from "../apps/server/src/codex-history";
import { readChatAttachmentImageFile } from "../apps/server/src/chat-attachments";
import { publishCodexHistoryAttachments } from "../apps/server/src/codex-history-attachments";

// Importing used to write images only to a staging folder, while media reads
// required managed references. Test the actual importer -> media-read boundary,
// plus today's Codex envelope and internal events from the same transcript.
test("current Codex history imports readable images and only the human prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpond-codex-import-"));
  const codexHome = path.join(root, "codex"), storageHome = path.join(root, "app");
  const attachmentRootDir = path.join(storageHome, "chat-attachments");
  const threadId = "019e7138-5da2-7671-8837-202a36e0abc1";
  const sessionId = codexHistorySessionId(threadId);
  const timestamp = "2026-10-21T03:15:00.000Z";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const message = (content: unknown[]) => ({ type: "response_item", timestamp, payload: { type: "message", role: "user", content } });
  const text = (value: string) => ({ type: "input_text", text: value });
  try {
    const directory = path.join(codexHome, "sessions", "2026", "10", "20");
    await mkdir(directory, { recursive: true });
    const records = [
      { type: "session_meta", timestamp, payload: { id: threadId, cwd: root, timestamp } },
      message([text('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>')]),
      message([text('# Files mentioned by the user:\n\n## Screenshot.png: /pictures/Screenshot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user’s request.\n\n## My request:\nPlease fix this preview.'),
        text('<image name=[Image #1] path="/pictures/Screenshot.png">'), { type: "input_image", image_url: `data:image/png;base64,${png}` }, text('</image>')]),
      message([text('Explain this literal tag: `<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>`')]),
    ];
    await writeFile(path.join(directory, `rollout-2026-10-20T23-15-00-${threadId}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const read = () => readCodexHistoryThreadPayload(sessionId, { codexHome, storageHome, attachmentRootDir });
    const payload = await read();
    const prompts = payload.events.filter(event => event.name === "turn.started");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.args?.prompt).toBe("Please fix this preview.");
    expect(prompts[1]?.args?.prompt).toContain("Explain this literal tag:");
    const attachment = ChatAttachmentSummarySchema.parse((prompts[0]!.args!.attachments as unknown[])[0]);
    const preview = attachment.imagePreview!;
    const image = await readChatAttachmentImageFile({ storageHome, attachmentRootDir, ...preview });
    expect(image?.bytes.equals(Buffer.from(png, "base64"))).toBe(true);
    // Re-importing and incremental reads keep the same immutable bytes/owner.
    const again = await read();
    expect(again.events.find(event => event.name === "turn.started")?.args?.attachments).toEqual([attachment]);
    await rm(attachmentRootDir, { recursive: true, force: true });
    expect((await readChatAttachmentImageFile({ storageHome, attachmentRootDir, ...preview }))?.bytes).toEqual(image?.bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A missing image must not break the conversation, and a substituted symlink
// must not register unrelated bytes under a trusted attachment identity.
test("unavailable and substituted imports retain records without preview access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpond-codex-import-scope-"));
  const attachmentRootDir = path.join(root, "attachments");
  try {
    const turnDir = path.join(attachmentRootDir, "session", "turn");
    await mkdir(turnDir, { recursive: true });
    const outside = path.join(root, "outside.png");
    await writeFile(outside, "private");
    await symlink(outside, path.join(turnDir, "link.png"));
    const attachments = ["missing.png", "link.png"].map(name => ({ id: name, name, kind: "image", mediaType: "image/png", sizeBytes: 7,
      imagePreview: { sessionId: "session", turnId: "turn", attachmentId: name, storageName: name, contentType: "image/png" } }));
    const events: RuntimeEvent[] = [{ id: "event", sessionId: "session", turnId: "turn", name: "turn.started", timestamp: new Date().toISOString(), args: { attachments } }];
    await publishCodexHistoryAttachments({ storageHome: root, attachmentRootDir, events });
    expect(attachments).toHaveLength(2);
    expect(attachments.every(attachment => !attachment.imagePreview)).toBe(true);
    await expect(readFile(outside, "utf8")).resolves.toBe("private");
  } finally { await rm(root, { recursive: true, force: true }); }
});
