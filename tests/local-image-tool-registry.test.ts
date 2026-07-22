import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createLocalImageModelToolDefinition } from "../apps/server/src/openpond/local-image-tool-registry";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("local image model tool", () => {
  test("reads real local pixels and exposes a trace preview without publishing a deliverable", async () => {
    const definition = createLocalImageModelToolDefinition();
    const session = {
      id: "session_1",
      provider: "openpond",
      workspaceKind: undefined,
      workspaceId: null,
      cwd: null,
      openPondCommandAccessMode: "full",
    } as any;
    expect(definition.enabled?.({
      session,
      provider: "openpond",
      model: "openpond-chat",
      mentionedApps: [],
    })).toBe(true);

    const imagePath = path.join(root, "apps", "web", "public", "favicon-16x16.png");
    const result = await definition.execute({
      session,
      turnId: "turn_1",
      turnPermissions: {},
      provider: "openpond",
      model: "openpond-chat",
      callId: "call_1",
      args: { path: imagePath },
      signal: new AbortController().signal,
      workspaceDiffBaseline: null,
      mentionedApps: [],
      userPrompt: "inspect it",
      turnMetadata: null,
    } as any);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      openpondImagePreviewPath: imagePath,
      width: 16,
      height: 16,
    });
    expect((result.data as any).artifacts).toBeUndefined();
    expect((result.data as any).luminanceMap).toHaveLength(8);
    expect((result.data as any).colorMap).toHaveLength(8);
  });
});
