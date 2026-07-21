import manifestJson from "./public-video-manifest.json";
import { publicAssetUrl } from "./public-assets";

export const PRODUCTION_MEDIA_ORIGIN = "https://media.openpond.ai";

export type PublicVideoAsset = {
  id: string;
  localPath: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  durationSeconds: number;
};

export type PublicVideoPlaylist = {
  fullVideoId?: string;
  id: string;
  playAllVideoId?: string;
  status: "draft" | "published";
  title: string;
  videoIds: string[];
};

type PublicVideoManifest = {
  schemaVersion: "openpond.publicVideoManifest.v1";
  playlists: PublicVideoPlaylist[];
  videos: PublicVideoAsset[];
};

const manifest = manifestJson as PublicVideoManifest;
const playlistsById = new Map(
  manifest.playlists.map((playlist) => [playlist.id, playlist]),
);
const videosById = new Map(manifest.videos.map((video) => [video.id, video]));

export function publicVideoPlaylist(id: string): PublicVideoPlaylist {
  const playlist = playlistsById.get(id);
  if (!playlist) {
    throw new Error(`Public video manifest is missing playlist ${id}`);
  }
  return playlist;
}

export function resolvePublicVideoUrl(
  video: PublicVideoAsset,
  production: boolean,
): string {
  return production
    ? `${PRODUCTION_MEDIA_ORIGIN}/${video.objectKey}`
    : publicAssetUrl(video.localPath);
}

export function publicVideoUrl(id: string): string {
  const video = videosById.get(id);
  if (!video) {
    throw new Error(`Public video manifest is missing ${id}`);
  }
  return resolvePublicVideoUrl(video, import.meta.env.PROD);
}

export const MAKE_AGENT_TUTORIAL_VIDEO_URL = publicVideoUrl(
  "make-agent-tutorial",
);

export const OPENPOND_AGENT_OVERVIEW_VIDEO_URL = publicVideoUrl(
  "openpond-agent-overview",
);

export function makeAgentTutorialVideoUrl(chapter: "create" | "use" | "improve"): string {
  return publicVideoUrl(`make-agent-tutorial-${chapter}`);
}

export const PUBLIC_VIDEO_MANIFEST = manifest;
