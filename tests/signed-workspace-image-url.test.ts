import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "vitest";

import {
  createHttpRequestHandler,
  signedChatAttachmentImageUrlPayload,
  signedLocalImageUrlPayload,
  type HttpRouteDeps,
  signedWorkspaceImageUrlPayload,
  verifySignedChatAttachmentImageRequest,
  verifySignedLocalImageRequest,
  verifySignedWorkspaceImageRequest,
} from "../apps/server/src/api/http-routes";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("signed workspace image URLs", () => {
  test("mints scoped URLs without exposing the server capability token", () => {
    const token = "server-capability-secret";
    const response = signedWorkspaceImageUrlPayload(
      { appId: "support-app", path: "./assets/pixel.png" },
      new URL("http://127.0.0.1:17876/v1/assets/workspace-image-url"),
      token,
    );
    const url = new URL(response.url);

    expect(url.pathname).toBe("/v1/assets/workspace-image");
    expect(url.searchParams.get("appId")).toBe("support-app");
    expect(url.searchParams.get("path")).toBe("assets/pixel.png");
    expect(url.searchParams.get("signature")).toBeTruthy();
    expect(response.url).not.toContain(token);
    expect(verifySignedWorkspaceImageRequest(url, token)).toEqual({
      ok: true,
      claims: { appId: "support-app", path: "assets/pixel.png", expiresAt: response.expiresAt },
    });
  });

  test("rejects tampered, expired, absolute, and non-image signed asset requests", () => {
    const token = "server-capability-secret";
    const response = signedWorkspaceImageUrlPayload(
      { appId: "support-app", path: "assets/pixel.png" },
      new URL("http://127.0.0.1:17876/v1/assets/workspace-image-url"),
      token,
    );
    const tampered = new URL(response.url);
    tampered.searchParams.set("path", "assets/other.png");
    expect(verifySignedWorkspaceImageRequest(tampered, token)).toMatchObject({
      ok: false,
      status: 401,
    });

    const expired = new URL(response.url);
    expired.searchParams.set("expiresAt", String(Date.now() - 1));
    expect(verifySignedWorkspaceImageRequest(expired, token)).toMatchObject({
      ok: false,
      error: "Signed asset URL expired.",
    });

    expect(() =>
      signedWorkspaceImageUrlPayload(
        { appId: "support-app", path: "/home/glu/private.png" },
        new URL("http://127.0.0.1:17876/v1/assets/workspace-image-url"),
        token,
      ),
    ).toThrow("Workspace image path is invalid.");
    expect(() =>
      signedWorkspaceImageUrlPayload(
        { appId: "support-app", path: "assets/readme.txt" },
        new URL("http://127.0.0.1:17876/v1/assets/workspace-image-url"),
        token,
      ),
    ).toThrow("Workspace image path is invalid.");
  });

  test("serves signed workspace images through the HTTP route without main-token URL auth", async () => {
    await withSignedImageServer(async ({ baseUrl, token }) => {
      const mintResponse = await fetch(`${baseUrl}/v1/assets/workspace-image-url`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ appId: "support-app", path: "assets/pixel.png" }),
      });
      expect(mintResponse.status).toBe(200);
      const minted = (await mintResponse.json()) as { url: string; expiresAt: number };
      expect(minted.url).toContain("/v1/assets/workspace-image");
      expect(minted.url).not.toContain(token);

      const imageResponse = await fetch(minted.url);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await imageResponse.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

      const tampered = new URL(minted.url);
      tampered.searchParams.set("path", "assets/other.png");
      expect((await fetch(tampered)).status).toBe(401);

      const oldLocalImageResponse = await fetch(`${baseUrl}/v1/local-image?path=/tmp/pixel.png`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(oldLocalImageResponse.status).toBe(410);
    });
  });

  test("mints scoped local image URLs without exposing the server capability token", () => {
    const token = "server-capability-secret";
    const response = signedLocalImageUrlPayload(
      { path: "/tmp/pixel.png" },
      new URL("http://127.0.0.1:17876/v1/assets/local-image-url"),
      token,
    );
    const url = new URL(response.url);

    expect(url.pathname).toBe("/v1/assets/local-image");
    expect(url.searchParams.get("path")).toBe("/tmp/pixel.png");
    expect(url.searchParams.get("signature")).toBeTruthy();
    expect(response.url).not.toContain(token);
    expect(verifySignedLocalImageRequest(url, token)).toEqual({
      ok: true,
      claims: { path: "/tmp/pixel.png", expiresAt: response.expiresAt },
    });
  });

  test("rejects tampered, expired, relative, and non-image local image requests", () => {
    const token = "server-capability-secret";
    const response = signedLocalImageUrlPayload(
      { path: "/tmp/pixel.png" },
      new URL("http://127.0.0.1:17876/v1/assets/local-image-url"),
      token,
    );
    const tampered = new URL(response.url);
    tampered.searchParams.set("path", "/tmp/other.png");
    expect(verifySignedLocalImageRequest(tampered, token)).toMatchObject({
      ok: false,
      status: 401,
    });

    const expired = new URL(response.url);
    expired.searchParams.set("expiresAt", String(Date.now() - 1));
    expect(verifySignedLocalImageRequest(expired, token)).toMatchObject({
      ok: false,
      error: "Signed asset URL expired.",
    });

    expect(() =>
      signedLocalImageUrlPayload(
        { path: "assets/pixel.png" },
        new URL("http://127.0.0.1:17876/v1/assets/local-image-url"),
        token,
      ),
    ).toThrow("Local image path is invalid.");
    expect(() =>
      signedLocalImageUrlPayload(
        { path: "/tmp/readme.txt" },
        new URL("http://127.0.0.1:17876/v1/assets/local-image-url"),
        token,
      ),
    ).toThrow("Local image path is invalid.");
  });

  test("serves signed local images through the HTTP route without main-token URL auth", async () => {
    await withSignedImageServer(async ({ baseUrl, token }) => {
      const mintResponse = await fetch(`${baseUrl}/v1/assets/local-image-url`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: "/tmp/pixel.png" }),
      });
      expect(mintResponse.status).toBe(200);
      const minted = (await mintResponse.json()) as { url: string; expiresAt: number };
      expect(minted.url).toContain("/v1/assets/local-image");
      expect(minted.url).not.toContain(token);

      const imageResponse = await fetch(minted.url);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await imageResponse.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

      const tampered = new URL(minted.url);
      tampered.searchParams.set("path", "/tmp/other.png");
      expect((await fetch(tampered)).status).toBe(401);
    });
  });

  test("mints scoped chat attachment image URLs without exposing the server capability token", () => {
    const token = "server-capability-secret";
    const response = signedChatAttachmentImageUrlPayload(
      {
        sessionId: "session_1",
        turnId: "turn_1",
        attachmentId: "attachment_1",
        storageName: "Screenshot from 2026-07-02 13.49.59.png",
        contentType: "image/png",
      },
      new URL("http://127.0.0.1:17876/v1/assets/chat-attachment-image-url"),
      token,
    );
    const url = new URL(response.url);

    expect(url.pathname).toBe("/v1/assets/chat-attachment-image");
    expect(url.searchParams.get("sessionId")).toBe("session_1");
    expect(url.searchParams.get("turnId")).toBe("turn_1");
    expect(url.searchParams.get("attachmentId")).toBe("attachment_1");
    expect(url.searchParams.get("storageName")).toBe("Screenshot from 2026-07-02 13.49.59.png");
    expect(url.searchParams.get("signature")).toBeTruthy();
    expect(response.url).not.toContain(token);
    expect(verifySignedChatAttachmentImageRequest(url, token)).toEqual({
      ok: true,
      claims: {
        sessionId: "session_1",
        turnId: "turn_1",
        attachmentId: "attachment_1",
        storageName: "Screenshot from 2026-07-02 13.49.59.png",
        contentType: "image/png",
        expiresAt: response.expiresAt,
      },
    });
  });

  test("rejects tampered, path-like, and non-browser-image chat attachment URLs", () => {
    const token = "server-capability-secret";
    const response = signedChatAttachmentImageUrlPayload(
      {
        sessionId: "session_1",
        turnId: "turn_1",
        attachmentId: "attachment_1",
        storageName: "screenshot.png",
        contentType: "image/png",
      },
      new URL("http://127.0.0.1:17876/v1/assets/chat-attachment-image-url"),
      token,
    );
    const tampered = new URL(response.url);
    tampered.searchParams.set("attachmentId", "attachment_2");
    expect(verifySignedChatAttachmentImageRequest(tampered, token)).toMatchObject({
      ok: false,
      status: 401,
    });

    expect(() =>
      signedChatAttachmentImageUrlPayload(
        {
          sessionId: "session_1",
          turnId: "turn_1",
          attachmentId: "attachment_1",
          storageName: "../private.png",
          contentType: "image/png",
        },
        new URL("http://127.0.0.1:17876/v1/assets/chat-attachment-image-url"),
        token,
      ),
    ).toThrow("Chat attachment image storage name is invalid.");
    expect(() =>
      signedChatAttachmentImageUrlPayload(
        {
          sessionId: "session_1",
          turnId: "turn_1",
          attachmentId: "attachment_1",
          storageName: "vector.svg",
          contentType: "image/svg+xml",
        },
        new URL("http://127.0.0.1:17876/v1/assets/chat-attachment-image-url"),
        token,
      ),
    ).toThrow("Chat attachment image content type is invalid.");
  });

  test("serves signed chat attachment images through the HTTP route without main-token URL auth", async () => {
    await withSignedImageServer(async ({ baseUrl, token }) => {
      const mintResponse = await fetch(`${baseUrl}/v1/assets/chat-attachment-image-url`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "session_1",
          turnId: "turn_1",
          attachmentId: "attachment_1",
          storageName: "screenshot.png",
          contentType: "image/png",
        }),
      });
      expect(mintResponse.status).toBe(200);
      const minted = (await mintResponse.json()) as { url: string; expiresAt: number };
      expect(minted.url).toContain("/v1/assets/chat-attachment-image");
      expect(minted.url).not.toContain(token);

      const imageResponse = await fetch(minted.url);
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await imageResponse.arrayBuffer()).equals(PNG_BYTES)).toBe(true);

      const tampered = new URL(minted.url);
      tampered.searchParams.set("storageName", "other.png");
      expect((await fetch(tampered)).status).toBe(401);
    });
  });
});

async function withSignedImageServer<T>(fn: (input: { baseUrl: string; token: string }) => Promise<T>): Promise<T> {
  const token = "route-token";
  const server = createServer(
    createHttpRequestHandler({
      host: "127.0.0.1",
      getActualPort: () => {
        const address = server.address() as AddressInfo | null;
        return address?.port ?? 0;
      },
      token,
      version: "test",
      runtimeVersion: "test",
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      subscribers: new Set<ServerResponse>(),
      workspaceImagePayload: async (appId: string, filePath: string | null) => {
        if (appId !== "support-app" || filePath !== "assets/pixel.png") throw new Error("Image not found");
        return {
          path: filePath,
          contentType: "image/png",
          bytes: PNG_BYTES,
          sizeBytes: PNG_BYTES.byteLength,
        };
      },
      localImagePayload: async (filePath: string) => {
        if (filePath !== "/tmp/pixel.png") throw new Error("Image not found");
        return {
          path: filePath,
          contentType: "image/png",
          bytes: PNG_BYTES,
          sizeBytes: PNG_BYTES.byteLength,
        };
      },
      chatAttachmentImagePayload: async (input) => {
        if (
          input.sessionId !== "session_1" ||
          input.turnId !== "turn_1" ||
          input.attachmentId !== "attachment_1" ||
          input.storageName !== "screenshot.png"
        ) {
          throw new Error("Image not found");
        }
        return {
          path: input.storageName,
          contentType: input.contentType,
          bytes: PNG_BYTES,
          sizeBytes: PNG_BYTES.byteLength,
        };
      },
    } as unknown as HttpRouteDeps),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${address.port}`, token });
  } finally {
    server.close();
    await once(server, "close");
  }
}
