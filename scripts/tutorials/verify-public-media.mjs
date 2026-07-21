#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicRoot = join(repositoryRoot, "apps/web/public");
const manifestPath = join(
  repositoryRoot,
  "apps/web/src/lib/public-video-manifest.json",
);
const mediaOrigin = "https://media.openpond.ai";
const requestOrigin = "http://127.0.0.1:17876";
const concurrency = 4;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== "openpond.publicVideoManifest.v1"
  || !Array.isArray(manifest.videos)
  || manifest.videos.length === 0
) {
  throw new Error(`Invalid public video manifest: ${manifestPath}`);
}

function publicUrl(objectKey) {
  return `${mediaOrigin}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

function validateLocalVideo(video) {
  if (
    typeof video.id !== "string"
    || typeof video.localPath !== "string"
    || video.localPath.startsWith("/")
    || video.localPath.split("/").some((part) => !part || part === "." || part === "..")
    || !video.localPath.endsWith(".mp4")
    || typeof video.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(video.sha256)
    || video.objectKey !== `media/videos/${video.sha256}.mp4`
    || !Number.isSafeInteger(video.sizeBytes)
    || video.sizeBytes <= 0
  ) {
    throw new Error(`Invalid public video entry: ${JSON.stringify(video)}`);
  }
  const filePath = join(publicRoot, video.localPath);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Local public video is missing: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== video.sizeBytes || actualSha256 !== video.sha256) {
    throw new Error(
      `Local video no longer matches the manifest: ${video.localPath}. Run pnpm media:prepare.`,
    );
  }
}

for (const video of manifest.videos) {
  validateLocalVideo(video);
}

async function verifyVideo(video) {
  const url = publicUrl(video.objectKey);
  const response = await fetch(url, {
    headers: {
      Origin: requestOrigin,
      Range: "bytes=0-0",
    },
  });
  await response.body?.cancel();

  const failures = [];
  if (response.status !== 206) failures.push(`HTTP ${response.status}; expected 206`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("video/mp4")) {
    failures.push(`content-type ${contentType || "missing"}`);
  }
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin !== "*" && allowOrigin !== requestOrigin) failures.push("CORS missing");
  if (!response.headers.get("cache-control")?.includes("immutable")) {
    failures.push("immutable cache policy missing");
  }
  const expectedRange = `bytes 0-0/${video.sizeBytes}`;
  if (response.headers.get("content-range") !== expectedRange) {
    failures.push(`content-range must be ${expectedRange}`);
  }
  return { failures, id: video.id, url };
}

const results = [];
let nextIndex = 0;
async function worker() {
  while (nextIndex < manifest.videos.length) {
    const video = manifest.videos[nextIndex];
    nextIndex += 1;
    try {
      results.push(await verifyVideo(video));
    } catch (error) {
      results.push({
        failures: [error instanceof Error ? error.message : String(error)],
        id: video.id,
        url: publicUrl(video.objectKey),
      });
    }
  }
}

await Promise.all(
  Array.from(
    { length: Math.min(concurrency, manifest.videos.length) },
    () => worker(),
  ),
);

const failed = results.filter((result) => result.failures.length > 0);
if (failed.length > 0) {
  for (const result of failed.toSorted((left, right) => left.id.localeCompare(right.id))) {
    console.error(`${result.id} (${result.url}): ${result.failures.join(", ")}`);
  }
  throw new Error(
    `Production video set is incomplete or invalid: ${failed.length}/${results.length} videos failed`,
  );
}

console.info(
  `Verified ${results.length} content-addressed videos at ${mediaOrigin}.`,
);
