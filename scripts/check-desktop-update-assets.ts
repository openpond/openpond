import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { desktopUpdateManifestName } from "../packages/contracts/src/desktop-updates.js";
import { validateDesktopUpdateManifest } from "../apps/desktop/src/desktop-update-release.js";

type Target = { platform: "darwin" | "linux"; arch: "x64" | "arm64" };
const TARGETS: Target[] = [
  { platform: "darwin", arch: "x64" }, { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" }, { platform: "linux", arch: "arm64" },
];

export async function checkDesktopUpdateAssets(input: {
  directory: string;
  channel: "stable" | "nightly";
  version: string;
  targets?: Target[];
}): Promise<void> {
  for (const target of input.targets ?? TARGETS) {
    const name = desktopUpdateManifestName(input.channel, target.platform, target.arch);
    const info = parse(await fs.readFile(path.join(input.directory, name), "utf8")) as {
      version: string; files: Array<{ url: string; sha512: string }>;
    };
    const context = { ...target, channel: input.channel, installedVersion: "0.0.0-0" };
    validateDesktopUpdateManifest(info, context, target.platform === "darwin" ? "mac" : "appimage", input.version);
    if (target.platform === "linux") validateDesktopUpdateManifest(info, context, "deb", input.version);
    const seen = new Set<string>();
    for (const file of info.files) {
      if (seen.has(file.url)) throw new Error(`Duplicate update artifact in ${name}: ${file.url}`);
      seen.add(file.url);
      const hash = createHash("sha512");
      for await (const chunk of createReadStream(path.join(input.directory, file.url))) hash.update(chunk);
      if (hash.digest("base64") !== file.sha512) throw new Error(`Update artifact hash mismatch: ${file.url}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const channel = arg("channel");
  const version = arg("version");
  const directory = arg("dir");
  if ((channel !== "stable" && channel !== "nightly") || !version || !directory) {
    throw new Error("Usage: check-desktop-update-assets.ts --dir <assets> --channel stable|nightly --version <version>");
  }
  await checkDesktopUpdateAssets({ directory: path.resolve(directory), channel, version });
  console.log("Desktop update manifests and artifact hashes verified for Mac/Linux x64/arm64.");
}
