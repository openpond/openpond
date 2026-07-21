import { describe, expect, test } from "vitest";

import {
  connectedAppIconUrl,
  OPENPOND_ICON_URL,
  OPENPOND_WORDMARK_WHITE_URL,
  publicAssetUrl,
  TOKEN_ICON_URLS,
} from "../apps/web/src/lib/public-assets";
import {
  MAKE_AGENT_TUTORIAL_VIDEO_URL,
  PRODUCTION_MEDIA_ORIGIN,
  PUBLIC_VIDEO_MANIFEST,
  resolvePublicVideoUrl,
} from "../apps/web/src/lib/public-video-assets";

describe("web public asset URLs", () => {
  test("resolve beside the packaged renderer instead of the filesystem root", () => {
    const rendererUrl = "file:///Applications/openpond.app/Contents/Resources/web/index.html";
    const assetUrls = [
      OPENPOND_ICON_URL,
      OPENPOND_WORDMARK_WHITE_URL,
      MAKE_AGENT_TUTORIAL_VIDEO_URL,
      connectedAppIconUrl("github"),
      TOKEN_ICON_URLS.ETH,
    ];

    for (const assetUrl of assetUrls) {
      expect(assetUrl.startsWith("./")).toBe(true);
      expect(new URL(assetUrl, rendererUrl).pathname.startsWith(
        "/Applications/openpond.app/Contents/Resources/web/",
      )).toBe(true);
    }
  });

  test("normalizes callers that pass a leading slash", () => {
    expect(publicAssetUrl("/openpond-icon.png")).toBe("./openpond-icon.png");
    expect(publicAssetUrl("./openpond-icon.png")).toBe("./openpond-icon.png");
  });

  test("uses local MP4s in development and immutable manifest keys in production", () => {
    expect(PUBLIC_VIDEO_MANIFEST.playlists).toContainEqual(expect.objectContaining({
      id: "post-training-from-first-principles",
      status: "draft",
      videoIds: expect.arrayContaining([
        "post-training-01-how-post-training-works",
        "post-training-10-technical-appendix",
      ]),
    }));
    expect(PUBLIC_VIDEO_MANIFEST.videos).toHaveLength(11);
    for (const video of PUBLIC_VIDEO_MANIFEST.videos) {
      expect(resolvePublicVideoUrl(video, false)).toBe(`./${video.localPath}`);
      expect(resolvePublicVideoUrl(video, true)).toBe(
        `${PRODUCTION_MEDIA_ORIGIN}/media/videos/${video.sha256}.mp4`,
      );
      expect(video.objectKey).toBe(`media/videos/${video.sha256}.mp4`);
    }
  });
});
