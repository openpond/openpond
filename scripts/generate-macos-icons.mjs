import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const buildDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/desktop/build");
// Inset the existing artwork by 96px per side on a 1024px canvas. This matches
// the visual footprint of macOS icons without changing the shared logo assets.
const artworkScale = 832 / 1024;
const representations = [
  ["ic04", 16], ["ic05", 32],
  ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
  ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
];

// Area resampling preserves thin strokes at Finder sizes. Use interpolated
// samples when enlarging the source, with premultiplied alpha at curved edges.
function sampleWeights(sourceSize, targetSize, coordinate) {
  const scale = sourceSize / targetSize;
  if (scale < 1) {
    const position = (coordinate + 0.5) * scale - 0.5;
    const start = Math.floor(position);
    const fraction = position - start;
    return [
      [Math.max(0, Math.min(sourceSize - 1, start)), 1 - fraction],
      [Math.max(0, Math.min(sourceSize - 1, start + 1)), fraction],
    ];
  }
  const start = coordinate * scale;
  const end = start + scale;
  const weights = [];
  for (let index = Math.floor(start); index < Math.ceil(end); index++) {
    if (index < sourceSize) weights.push([index, (Math.min(end, index + 1) - Math.max(start, index)) / scale]);
  }
  return weights;
}

function renderIcon(source, size) {
  const image = new PNG({ width: size, height: size });
  const inset = Math.round(size * (1 - artworkScale) / 2);
  const artworkSize = size - inset * 2;
  const weights = Array.from({ length: artworkSize }, (_, index) => sampleWeights(source.width, artworkSize, index));
  for (let y = 0; y < artworkSize; y++) {
    for (let x = 0; x < artworkSize; x++) {
      const channels = [0, 0, 0];
      let alpha = 0;
      for (const [sourceY, weightY] of weights[y]) {
        for (const [sourceX, weightX] of weights[x]) {
          const offset = (sourceY * source.width + sourceX) * 4;
          const contribution = source.data[offset + 3] * weightX * weightY;
          alpha += contribution;
          for (let channel = 0; channel < 3; channel++) channels[channel] += source.data[offset + channel] * contribution;
        }
      }
      const offset = ((y + inset) * size + x + inset) * 4;
      for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = alpha ? Math.round(channels[channel] / alpha) : 0;
      image.data[offset + 3] = Math.round(alpha);
    }
  }
  return image;
}

// Small 1x icons must use straight ARGB planes, not PNG in icp4/icp5/icp6.
// Format reference: electron-userland/electron-builder-binaries, icons 1.2.3.
// Literal PackBits blocks (1..128 samples) keep this encoder small and portable.
function encodeArgb(image) {
  const blocks = [Buffer.from("ARGB")];
  const pixelCount = image.width * image.height;
  for (const channel of [3, 0, 1, 2]) {
    for (let start = 0; start < pixelCount; start += 128) {
      const count = Math.min(128, pixelCount - start);
      const block = Buffer.alloc(count + 1);
      block[0] = count - 1;
      for (let index = 0; index < count; index++) block[index + 1] = image.data[(start + index) * 4 + channel];
      blocks.push(block);
    }
  }
  return Buffer.concat(blocks);
}

export function generateMacosIcons(sourceBuffer) {
  const source = PNG.sync.read(sourceBuffer);
  if (source.width !== source.height || source.width < 512) throw new Error("macOS icon source must be square and at least 512px.");
  const images = new Map(representations.map(([, size]) => [size, null]));
  for (const size of images.keys()) images.set(size, renderIcon(source, size));
  const chunks = representations.map(([type, size]) => {
    const image = images.get(size);
    const payload = type === "ic04" || type === "ic05" ? encodeArgb(image) : PNG.sync.write(image);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(payload.length + 8, 4);
    return Buffer.concat([header, payload]);
  });
  const length = chunks.reduce((total, chunk) => total + chunk.length, 8);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(length, 4);
  return { icns: Buffer.concat([header, ...chunks]), png: PNG.sync.write(images.get(512)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const icons = generateMacosIcons(readFileSync(path.join(buildDirectory, "icon-source.png")));
  writeFileSync(path.join(buildDirectory, "icon.icns"), icons.icns);
  writeFileSync(path.join(buildDirectory, "icon-mac.png"), icons.png);
  console.log("Generated macOS bundle and development icons.");
}
