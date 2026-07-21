#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicRoot = join(repositoryRoot, "apps/web/public");
const manifestPath = join(
  repositoryRoot,
  "apps/web/src/lib/public-video-manifest.json",
);
const courseRoot = join(publicRoot, "courses/post-training");

const courseVideos = readdirSync(courseRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^\d{2}-.+\.mp4$/.test(entry.name))
  .map((entry) => ({
    id: `post-training-${basename(entry.name, ".mp4")}`,
    localPath: `courses/post-training/${entry.name}`,
  }))
  .toSorted((left, right) => left.localPath.localeCompare(right.localPath));

if (courseVideos.length !== 10) {
  throw new Error(`Expected 10 post-training lesson videos, found ${courseVideos.length}`);
}

const makeAgentVideos = [
  {
    id: "make-agent-tutorial",
    localPath: "tutorials/how-to-make-an-agent.mp4",
  },
  ...["create", "use", "improve"].map((chapter) => ({
    id: `make-agent-tutorial-${chapter}`,
    localPath: `tutorials/how-to-make-an-agent-${chapter}.mp4`,
  })),
];

const agentOverviewVideo = {
  id: "openpond-agent-overview",
  localPath: "tutorials/what-is-an-openpond-agent.mp4",
};

const fullCourseVideo = {
  id: "post-training-full-course",
  localPath: "courses/post-training/full-course.mp4",
};

const catalog = [
  ...courseVideos,
  fullCourseVideo,
  agentOverviewVideo,
  ...makeAgentVideos,
];

function durationSeconds(filePath) {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8" },
  );
  const duration = Number.parseFloat(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine video duration: ${filePath}`);
  }
  return Number(duration.toFixed(3));
}

const ids = new Set();
const localPaths = new Set();
const videos = catalog.map(({ id, localPath }) => {
  if (ids.has(id) || localPaths.has(localPath)) {
    throw new Error(`Duplicate public video entry: ${id} (${localPath})`);
  }
  ids.add(id);
  localPaths.add(localPath);

  const filePath = join(publicRoot, localPath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Public video is missing: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id,
    localPath,
    objectKey: `media/videos/${sha256}.mp4`,
    sha256,
    sizeBytes: bytes.byteLength,
    durationSeconds: durationSeconds(filePath),
  };
});

const manifest = {
  schemaVersion: "openpond.publicVideoManifest.v1",
  playlists: [
    {
      id: "post-training-from-first-principles",
      fullVideoId: fullCourseVideo.id,
      status: "draft",
      title: "Post-training from first principles",
      videoIds: courseVideos.map((video) => video.id),
    },
    {
      id: "how-to-make-an-agent",
      status: "published",
      title: "Agents",
      playAllVideoId: "make-agent-tutorial",
      videoIds: makeAgentVideos.slice(1).map((video) => video.id),
    },
  ],
  videos,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const previous = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
if (previous !== serialized) {
  writeFileSync(manifestPath, serialized, "utf8");
  console.info(`Updated ${manifestPath}`);
} else {
  console.info(`Manifest unchanged: ${manifestPath}`);
}
console.info(`Prepared ${videos.length} content-addressed public videos.`);
