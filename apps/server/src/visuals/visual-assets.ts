import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { HTML_VISUAL_MAX_BUNDLE_BYTES, HTML_VISUAL_MAX_BYTES } from "@openpond/contracts/html-visuals";
function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')))
    return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  return null;
}
export async function bundleVisualAssets(html: string, assets: {
  name: string;
  path: string;
}[], cwd: string | null): Promise<string> {
  if (Buffer.byteLength(html) > HTML_VISUAL_MAX_BYTES)
    throw new Error('HTML exceeds 64,000 UTF-8 bytes.');
  if (!assets.length)
    return html;
  if (!cwd)
    throw new Error('Local image assets require an authorized local workspace.');
  const root = await fs.realpath(cwd);
  let total = 0;
  const names = new Set<string>();
  for (const asset of assets) {
    if (names.has(asset.name))
      throw new Error('Asset names must be unique.');
    names.add(asset.name);
    const file = await fs.realpath(path.resolve(root, asset.path));
    const relative = path.relative(root, file);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.')))
      throw new Error('Image asset is outside the visible workspace.');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      const remaining = 4 * 1024 * 1024 - total;
      if (!stat.isFile() || stat.size > remaining)
        throw new Error('Image assets exceed 4 MiB.');
      const bounded = Buffer.alloc(remaining + 1);
      let length = 0;
      while (length < bounded.length) {
        const read = await handle.read(bounded, length, bounded.length - length, null);
        if (!read.bytesRead)
          break;
        length += read.bytesRead;
      }
      if (length > remaining)
        throw new Error('Image assets exceed 4 MiB.');
      bytes = bounded.subarray(0, length);
    }
    finally {
      await handle.close();
    }
    total += bytes.length;
    const type = imageType(bytes);
    if (!type)
      throw new Error('Only PNG, JPEG, GIF and WebP image bytes can be bundled.');
    html = html.replace(new RegExp(`asset:${asset.name}(?![a-zA-Z0-9_-])`, 'g'), `data:${type};base64,${bytes.toString('base64')}`);
  }
  if (Buffer.byteLength(html) > HTML_VISUAL_MAX_BUNDLE_BYTES)
    throw new Error('Bundled visual exceeds 6 MiB.');
  return html;
}
