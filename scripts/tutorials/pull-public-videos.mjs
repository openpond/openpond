#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicRoot = join(repositoryRoot, "apps/web/public");
const manifestPath = join(
  repositoryRoot,
  "apps/web/src/lib/public-video-manifest.json",
);
const mediaOrigin = "https://media.openpond.ai";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (
  manifest.schemaVersion !== "openpond.publicVideoManifest.v1"
  || !Array.isArray(manifest.videos)
  || manifest.videos.length === 0
) {
  throw new Error(`Invalid public video manifest: ${manifestPath}`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicUrl(objectKey) {
  return `${mediaOrigin}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

let restoredCount = 0;
let reusedCount = 0;
for (const video of manifest.videos) {
  if (
    !/^[0-9a-f]{64}$/.test(video.sha256)
    || video.objectKey !== `media/videos/${video.sha256}.mp4`
    || typeof video.localPath !== "string"
    || video.localPath.startsWith("/")
    || video.localPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid manifest entry: ${video.id}`);
  }

  const destination = join(publicRoot, video.localPath);
  if (existsSync(destination)) {
    const bytes = readFileSync(destination);
    if (bytes.byteLength !== video.sizeBytes || digest(bytes) !== video.sha256) {
      throw new Error(
        `Local video differs from the manifest: ${destination}. Preserve or rebuild it before pulling.`,
      );
    }
    reusedCount += 1;
    continue;
  }

  const url = publicUrl(video.objectKey);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not restore ${video.id}: ${url} returned HTTP ${response.status}`);
  }
  if (!response.headers.get("content-type")?.startsWith("video/mp4")) {
    throw new Error(`Could not restore ${video.id}: ${url} is not video/mp4`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== video.sizeBytes || digest(bytes) !== video.sha256) {
    throw new Error(`Downloaded video failed its manifest checksum: ${video.id}`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.download-${process.pid}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
    if (statSync(temporaryPath).size !== video.sizeBytes) {
      throw new Error(`Temporary video write was incomplete: ${temporaryPath}`);
    }
    renameSync(temporaryPath, destination);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  restoredCount += 1;
  console.info(`Restored ${video.id}`);
}

console.info(
  `Local public videos are ready: ${restoredCount} restored, ${reusedCount} already present.`,
);
